import { beforeEach, describe, expect, test } from 'bun:test';
import { addMember, addRole, createCommunity, createHarness, type TestHarness } from '../mocks/harness.ts';

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

async function fixture() {
  const community = await createCommunity(harness);
  const voiceChannel = community.channels.find((channel) => channel.type === 'voice')!;
  const textChannel = community.channels.find((channel) => channel.type === 'text')!;
  const everyone = await harness.store.repositories.role.findEveryone(community.id);
  await harness.store.repositories.role.update(everyone!.id, {
    permissions: ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'SEND_MESSAGES', 'CONNECT', 'SPEAK', 'VIDEO'],
    updatedAt: harness.now(),
  });
  const memberRole = await addRole(harness, community.id, {
    name: 'Member',
    position: 1,
    permissions: ['VIEW_CHANNEL'],
  });
  await addMember(harness, community.id, 'member-1', [memberRole]);
  return { community, textChannel, voiceChannel };
}

describe('internal authentication', () => {
  test('rejects a missing token without reaching business logic', async () => {
    const { textChannel } = await fixture();
    const response = await harness.request(
      'GET',
      `/internal/v1/channels/${textChannel.id}/access/member-1`,
    );
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  test('rejects an unknown token', async () => {
    const { textChannel } = await fixture();
    const response = await harness.request(
      'GET',
      `/internal/v1/channels/${textChannel.id}/access/member-1`,
      { token: 'wrong-token' },
    );
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_token');
  });
});

describe('GET /internal/v1/channels/:channel_id/access/:user_id', () => {
  test('returns the resolved flags for a member', async () => {
    const { community, textChannel } = await fixture();
    const response = await harness.request(
      'GET',
      `/internal/v1/channels/${textChannel.id}/access/member-1`,
      { internal: true },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      community_id: community.id,
      channel_type: 'text',
      is_member: true,
      can_view: true,
      can_read_history: true,
      can_send: true,
      can_connect: true,
      can_speak: true,
      can_video: true,
      timed_out_until: null,
      banned: false,
    });
  });

  test('a timeout blocks sending and voice actions', async () => {
    const { community, voiceChannel } = await fixture();
    const until = new Date(harness.now().getTime() + 60_000);
    await harness.store.repositories.membership.setTimedOutUntil(
      community.id,
      'member-1',
      until,
    );

    const response = await harness.request(
      'GET',
      `/internal/v1/channels/${voiceChannel.id}/access/member-1`,
      { internal: true },
    );
    expect(response.status).toBe(200);
    expect(response.body.can_connect).toBe(true);
    expect(response.body.can_speak).toBe(false);
    expect(response.body.can_video).toBe(false);
    expect(response.body.timed_out_until).toBe(until.toISOString());
  });

  test('a channel overwrite denying VIEW_CHANNEL is reflected', async () => {
    const { community, textChannel } = await fixture();
    await harness.store.repositories.overwrite.upsert({
      id: 'overwrite-1',
      channelId: textChannel.id,
      targetType: 'member',
      targetId: 'member-1',
      allow: [],
      deny: ['VIEW_CHANNEL'],
      createdAt: harness.now(),
      updatedAt: harness.now(),
    });

    const response = await harness.request(
      'GET',
      `/internal/v1/channels/${textChannel.id}/access/member-1`,
      { internal: true },
    );
    expect(response.body.can_view).toBe(false);
    expect(response.body.can_send).toBe(false);
    void community;
  });

  test('a banned user is reported as banned with no access', async () => {
    const { community, textChannel } = await fixture();
    await harness.store.repositories.ban.upsert({
      id: 'ban-1',
      communityId: community.id,
      userId: 'member-1',
      reason: 'spam',
      memberMessage: null,
      expiresAt: null,
      createdBy: 'owner',
      createdAt: harness.now(),
    });

    const response = await harness.request(
      'GET',
      `/internal/v1/channels/${textChannel.id}/access/member-1`,
      { internal: true },
    );
    expect(response.status).toBe(200);
    expect(response.body.banned).toBe(true);
    expect(response.body.can_view).toBe(false);
  });

  test('a non-member fails closed', async () => {
    const { textChannel } = await fixture();
    const response = await harness.request(
      'GET',
      `/internal/v1/channels/${textChannel.id}/access/stranger`,
      { internal: true },
    );
    expect(response.status).toBe(200);
    expect(response.body.is_member).toBe(false);
    expect(response.body.can_view).toBe(false);
  });

  test('returns 404 for an unknown channel', async () => {
    const response = await harness.request(
      'GET',
      '/internal/v1/channels/00000000-0000-4000-8000-000000000000/access/member-1',
      { internal: true },
    );
    expect(response.status).toBe(404);
  });

  test('records the access-check duration metric', async () => {
    const { textChannel } = await fixture();
    await harness.request('GET', `/internal/v1/channels/${textChannel.id}/access/member-1`, {
      internal: true,
    });
    const metric = await harness.metrics.accessCheckDuration.get();
    // Histograms expose the total observation count in the `+Inf` bucket.
    const channelEntry = metric.values.find(
      (value) =>
        value.labels.endpoint === 'channel_access' &&
        (value.labels as Record<string, unknown>).le === '+Inf',
    );
    expect(channelEntry?.value).toBe(1);
  });
});

describe('GET /internal/v1/communities/:community_id/members/:user_id/access', () => {
  test('returns visible channel ids for a member', async () => {
    const { community, textChannel, voiceChannel } = await fixture();
    const response = await harness.request(
      'GET',
      `/internal/v1/communities/${community.id}/members/member-1/access`,
      { internal: true },
    );
    expect(response.status).toBe(200);
    expect(response.body.is_member).toBe(true);
    expect(response.body.banned).toBe(false);
    expect(response.body.visible_channel_ids.sort()).toEqual([textChannel.id, voiceChannel.id].sort());
  });

  test('hides channels denied by an overwrite', async () => {
    const { community, textChannel, voiceChannel } = await fixture();
    await harness.store.repositories.overwrite.upsert({
      id: 'overwrite-1',
      channelId: voiceChannel.id,
      targetType: 'member',
      targetId: 'member-1',
      allow: [],
      deny: ['VIEW_CHANNEL'],
      createdAt: harness.now(),
      updatedAt: harness.now(),
    });

    const response = await harness.request(
      'GET',
      `/internal/v1/communities/${community.id}/members/member-1/access`,
      { internal: true },
    );
    expect(response.body.visible_channel_ids).toEqual([textChannel.id]);

    const metric = await harness.metrics.accessCheckDuration.get();
    expect(metric.values.some((value) => value.labels.endpoint === 'member_access')).toBe(true);
  });

  test('a banned user sees no channels', async () => {
    const { community } = await fixture();
    await harness.store.repositories.ban.upsert({
      id: 'ban-1',
      communityId: community.id,
      userId: 'member-1',
      reason: 'spam',
      memberMessage: null,
      expiresAt: null,
      createdBy: 'owner',
      createdAt: harness.now(),
    });

    const response = await harness.request(
      'GET',
      `/internal/v1/communities/${community.id}/members/member-1/access`,
      { internal: true },
    );
    expect(response.body.banned).toBe(true);
    expect(response.body.visible_channel_ids).toEqual([]);
  });

  test('returns 404 for an unknown community', async () => {
    const response = await harness.request(
      'GET',
      '/internal/v1/communities/00000000-0000-4000-8000-000000000000/members/member-1/access',
      { internal: true },
    );
    expect(response.status).toBe(404);
  });
});
