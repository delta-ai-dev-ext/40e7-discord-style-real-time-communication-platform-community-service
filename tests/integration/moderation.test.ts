import { beforeEach, describe, expect, test } from 'bun:test';
import { addMember, addRole, createCommunity, createHarness, type TestHarness } from '../mocks/harness.ts';

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

async function fixture() {
  const community = await createCommunity(harness);
  const base = `/v1/communities/${community.id}`;
  const moderatorRole = await addRole(harness, community.id, {
    name: 'Moderator',
    position: 5,
    permissions: ['TIMEOUT_MEMBERS', 'KICK_MEMBERS', 'BAN_MEMBERS', 'VIEW_CHANNEL'],
  });
  await addMember(harness, community.id, 'mod', [moderatorRole]);
  await addMember(harness, community.id, 'target');
  return { community, base, moderatorRole };
}

describe('POST /v1/communities/:id/moderation/timeouts', () => {
  test('times a member out with audit + event carrying voice channel ids', async () => {
    const { community, base } = await fixture();
    const response = await harness.request('POST', `${base}/moderation/timeouts`, {
      as: 'mod',
      body: {
        user_id: 'target',
        duration_seconds: 600,
        reason: 'cooling off',
        member_message: 'Take a short break.',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.user_id).toBe('target');
    expect(new Date(response.body.timed_out_until).getTime()).toBe(harness.now().getTime() + 600_000);

    const audit = harness.store.state.auditLog.at(-1);
    expect(audit?.action).toBe('member_timed_out');
    expect(audit?.reason).toBe('cooling off');

    const voiceChannelIds = community.channels
      .filter((channel) => channel.type === 'voice')
      .map((channel) => channel.id);
    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.eventType).toBe('member_timed_out');
    expect(event?.payload).toMatchObject({
      community_id: community.id,
      user_id: 'target',
      moderator_user_id: 'mod',
      member_message: 'Take a short break.',
    });
    expect((event?.payload as { voice_channel_ids: string[] }).voice_channel_ids).toEqual(
      voiceChannelIds,
    );

    const counter = await harness.metrics.moderationActions.get();
    expect(counter.values.find((value) => value.labels.action === 'timeout')?.value).toBe(1);
  });

  test('rejects a duration above 28 days', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/moderation/timeouts`, {
      as: 'mod',
      body: { user_id: 'target', duration_seconds: 2419201, reason: 'too long' },
    });
    expect(response.status).toBe(400);
  });

  test('accepts exactly 28 days', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/moderation/timeouts`, {
      as: 'mod',
      body: { user_id: 'target', duration_seconds: 2419200, reason: 'max' },
    });
    expect(response.status).toBe(200);
  });

  test('the owner cannot be timed out', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/moderation/timeouts`, {
      as: 'mod',
      body: { user_id: 'owner', duration_seconds: 600, reason: 'nope' },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('owner_protected');
  });

  test('a member at or above the moderator position is protected', async () => {
    const { community, base } = await fixture();
    const peerRole = await addRole(harness, community.id, { name: 'Peer', position: 5 });
    await addMember(harness, community.id, 'peer', [peerRole]);

    const response = await harness.request('POST', `${base}/moderation/timeouts`, {
      as: 'mod',
      body: { user_id: 'peer', duration_seconds: 600, reason: 'hierarchy' },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('hierarchy_violation');
  });

  test('a member without TIMEOUT_MEMBERS is rejected', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/moderation/timeouts`, {
      as: 'target',
      body: { user_id: 'mod', duration_seconds: 600, reason: 'nope' },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('missing_permission');
  });

  test('returns 404 when the target is not a member', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/moderation/timeouts`, {
      as: 'mod',
      body: { user_id: 'ghost', duration_seconds: 600, reason: 'nope' },
    });
    expect(response.status).toBe(404);
  });
});

describe('DELETE /v1/communities/:id/moderation/timeouts/:user_id', () => {
  test('clears an active timeout with audit + event', async () => {
    const { base } = await fixture();
    await harness.request('POST', `${base}/moderation/timeouts`, {
      as: 'mod',
      body: { user_id: 'target', duration_seconds: 600, reason: 'cooling off' },
    });

    const response = await harness.request('DELETE', `${base}/moderation/timeouts/target?reason=appeal`, {
      as: 'mod',
    });
    expect(response.status).toBe(204);
    expect(harness.store.state.auditLog.at(-1)?.action).toBe('member_timeout_cleared');
    expect([...harness.store.state.outbox.values()].at(-1)?.eventType).toBe(
      'member_timeout_cleared',
    );

    const membership = await harness.store.repositories.membership.find(
      harness.store.state.communities.keys().next().value as string,
      'target',
    );
    expect(membership?.timedOutUntil).toBeNull();
  });

  test('clearing a timeout that is not active is idempotent and silent', async () => {
    const { base } = await fixture();
    const response = await harness.request('DELETE', `${base}/moderation/timeouts/target`, {
      as: 'mod',
    });
    expect(response.status).toBe(204);
    expect(harness.store.state.auditLog).toHaveLength(0);
    expect(harness.store.state.outbox.size).toBe(0);
  });

  test('clearing an already-expired timeout emits nothing', async () => {
    const { community, base } = await fixture();
    await harness.store.repositories.membership.setTimedOutUntil(
      community.id,
      'target',
      new Date(harness.now().getTime() - 1000),
    );
    const response = await harness.request('DELETE', `${base}/moderation/timeouts/target`, {
      as: 'mod',
    });
    expect(response.status).toBe(204);
    expect(harness.store.state.outbox.size).toBe(0);
  });

  test('returns 404 for a non-member', async () => {
    const { base } = await fixture();
    const response = await harness.request('DELETE', `${base}/moderation/timeouts/ghost`, {
      as: 'mod',
    });
    expect(response.status).toBe(404);
  });
});

describe('POST /v1/communities/:id/moderation/kicks', () => {
  test('kicks the member, removing membership and roles', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, { name: 'Fan', position: 1 });
    await harness.store.repositories.memberRole.assign({
      communityId: community.id,
      userId: 'target',
      roleId,
      assignedBy: 'mod',
      assignedAt: harness.now(),
    });

    const response = await harness.request('POST', `${base}/moderation/kicks`, {
      as: 'mod',
      body: { user_id: 'target', reason: 'spam', member_message: 'Please rejoin later.' },
    });
    expect(response.status).toBe(204);
    expect(await harness.store.repositories.membership.find(community.id, 'target')).toBeNull();
    expect(await harness.store.repositories.memberRole.listForMember(community.id, 'target')).toEqual([]);
    expect(harness.store.state.auditLog.at(-1)?.action).toBe('member_kicked');

    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.eventType).toBe('member_kicked');
    expect(event?.payload).toMatchObject({
      user_id: 'target',
      moderator_user_id: 'mod',
      member_message: 'Please rejoin later.',
    });
  });

  test('the owner cannot be kicked', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/moderation/kicks`, {
      as: 'mod',
      body: { user_id: 'owner', reason: 'nope' },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('owner_protected');
  });

  test('a non-member cannot be kicked', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/moderation/kicks`, {
      as: 'mod',
      body: { user_id: 'ghost', reason: 'nope' },
    });
    expect(response.status).toBe(404);
  });
});

describe('bans', () => {
  test('ban creates the row, removes membership and emits member_banned with expiry', async () => {
    const { community, base } = await fixture();
    const expiresAt = new Date(harness.now().getTime() + 86_400_000).toISOString();

    const response = await harness.request('POST', `${base}/moderation/bans`, {
      as: 'mod',
      body: { user_id: 'target', reason: 'harassment', member_message: 'See you later.', expires_at: expiresAt },
    });

    expect(response.status).toBe(201);
    expect(response.body.expires_at).toBe(expiresAt);
    expect(response.body.created_by).toBe('mod');
    expect(await harness.store.repositories.membership.find(community.id, 'target')).toBeNull();

    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.eventType).toBe('member_banned');
    expect(event?.payload).toMatchObject({
      user_id: 'target',
      member_message: 'See you later.',
      ban_expires_at: expiresAt,
    });
    expect(harness.store.state.auditLog.at(-1)?.action).toBe('member_banned');
  });

  test('a permanent ban has a null expiry', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/moderation/bans`, {
      as: 'mod',
      body: { user_id: 'target', reason: 'permanent' },
    });
    expect(response.status).toBe(201);
    expect(response.body.expires_at).toBeNull();
  });

  test('rejects an expiry in the past', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/moderation/bans`, {
      as: 'mod',
      body: { user_id: 'target', reason: 'past', expires_at: new Date(harness.now().getTime() - 1000).toISOString() },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_error');
  });

  test('the owner cannot be banned', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/moderation/bans`, {
      as: 'mod',
      body: { user_id: 'owner', reason: 'nope' },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('owner_protected');
  });

  test('lists bans newest first with pagination', async () => {
    const { community, base } = await fixture();
    await addMember(harness, community.id, 'target-2');
    await harness.request('POST', `${base}/moderation/bans`, {
      as: 'mod',
      body: { user_id: 'target', reason: 'first' },
    });
    harness.setNow(new Date(harness.now().getTime() + 1000));
    await harness.request('POST', `${base}/moderation/bans`, {
      as: 'mod',
      body: { user_id: 'target-2', reason: 'second' },
    });

    const response = await harness.request('GET', `${base}/moderation/bans?limit=1`, { as: 'mod' });
    expect(response.status).toBe(200);
    expect(response.body.bans).toHaveLength(1);
    expect(response.body.bans[0].user_id).toBe('target-2');
    expect(response.body.next_cursor).toBeTruthy();

    const next = await harness.request(
      'GET',
      `${base}/moderation/bans?limit=1&cursor=${encodeURIComponent(response.body.next_cursor)}`,
      { as: 'mod' },
    );
    expect(next.body.bans[0].user_id).toBe('target');
  });

  test('a member without BAN_MEMBERS cannot list bans', async () => {
    const { base } = await fixture();
    const response = await harness.request('GET', `${base}/moderation/bans`, { as: 'target' });
    expect(response.status).toBe(403);
  });

  test('unban removes the row with audit + event', async () => {
    const { community, base } = await fixture();
    await harness.request('POST', `${base}/moderation/bans`, {
      as: 'mod',
      body: { user_id: 'target', reason: 'temp' },
    });

    const response = await harness.request('DELETE', `${base}/moderation/bans/target?reason=appeal`, {
      as: 'mod',
    });
    expect(response.status).toBe(204);
    expect(await harness.store.repositories.ban.find(community.id, 'target')).toBeNull();
    expect(harness.store.state.auditLog.at(-1)?.action).toBe('member_unbanned');
    expect([...harness.store.state.outbox.values()].at(-1)?.eventType).toBe('member_unbanned');
  });

  test('unbanning an unbanned user returns 404', async () => {
    const { base } = await fixture();
    const response = await harness.request('DELETE', `${base}/moderation/bans/target`, { as: 'mod' });
    expect(response.status).toBe(404);
  });
});
