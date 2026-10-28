import { beforeEach, describe, expect, test } from 'bun:test';
import { addMember, addRole, createCommunity, createHarness, type TestHarness } from '../mocks/harness.ts';

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

async function ownerWithCommunity() {
  const community = await createCommunity(harness);
  return { community, base: `/v1/communities/${community.id}` };
}

describe('POST /v1/communities/:id/channels', () => {
  test('an owner (all permissions) creates a channel with audit + event', async () => {
    const { base } = await ownerWithCommunity();
    const response = await harness.request('POST', `${base}/channels`, {
      as: 'owner',
      body: { name: 'memes', type: 'text', position: 5 },
    });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe('memes');
    expect(response.body.position).toBe(5);
    expect(response.body.type).toBe('text');

    const audit = harness.store.state.auditLog.at(-1);
    expect(audit?.action).toBe('channel_created');
    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.eventType).toBe('channel_created');
    expect(event?.payload).toMatchObject({ channel_id: response.body.id, name: 'memes', position: 5 });
  });

  test('omitting position assigns the next slot', async () => {
    const { base } = await ownerWithCommunity();
    const response = await harness.request('POST', `${base}/channels`, {
      as: 'owner',
      body: { name: 'later', type: 'voice' },
    });
    expect(response.body.position).toBe(2);
  });

  test('a member without MANAGE_CHANNELS is rejected and nothing is audited', async () => {
    const { community, base } = await ownerWithCommunity();
    const role = await addRole(harness, community.id, {
      name: 'Chatter',
      position: 1,
      permissions: ['VIEW_CHANNEL'],
    });
    await addMember(harness, community.id, 'chatter', [role]);

    const response = await harness.request('POST', `${base}/channels`, {
      as: 'chatter',
      body: { name: 'sneaky', type: 'text' },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('missing_permission');
    expect(harness.store.state.auditLog).toHaveLength(0);
  });

  test('validates the channel type and name', async () => {
    const { base } = await ownerWithCommunity();
    const badType = await harness.request('POST', `${base}/channels`, {
      as: 'owner',
      body: { name: 'x', type: 'forum' },
    });
    expect(badType.status).toBe(400);
    const badName = await harness.request('POST', `${base}/channels`, {
      as: 'owner',
      body: { name: '', type: 'text' },
    });
    expect(badName.status).toBe(400);
  });

  test('returns 404 for an unknown community', async () => {
    const response = await harness.request(
      'POST',
      '/v1/communities/00000000-0000-4000-8000-000000000000/channels',
      { as: 'owner', body: { name: 'x', type: 'text' } },
    );
    expect(response.status).toBe(404);
  });
});

describe('PATCH/DELETE /v1/communities/:id/channels/:channel_id', () => {
  test('updates name and position with an audit entry and event', async () => {
    const { community, base } = await ownerWithCommunity();
    const channelId = community.channels[0]!.id;

    const response = await harness.request('PATCH', `${base}/channels/${channelId}`, {
      as: 'owner',
      body: { name: 'general-chat', position: 9 },
    });
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('general-chat');
    expect(response.body.position).toBe(9);

    const audit = harness.store.state.auditLog.at(-1);
    expect(audit?.action).toBe('channel_updated');
    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.eventType).toBe('channel_updated');
  });

  test('rejects an empty update body', async () => {
    const { community, base } = await ownerWithCommunity();
    const response = await harness.request('PATCH', `${base}/channels/${community.channels[0]!.id}`, {
      as: 'owner',
      body: {},
    });
    expect(response.status).toBe(400);
  });

  test('deletes a channel and emits channel_deleted with its type', async () => {
    const { community, base } = await ownerWithCommunity();
    const voice = community.channels.find((channel) => channel.type === 'voice')!;

    const response = await harness.request('DELETE', `${base}/channels/${voice.id}`, { as: 'owner' });
    expect(response.status).toBe(204);

    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.eventType).toBe('channel_deleted');
    expect(event?.payload).toMatchObject({ channel_id: voice.id, type: 'voice' });
    expect(await harness.store.repositories.channel.findById(voice.id)).toBeNull();
  });

  test('returns 404 when the channel belongs to another community', async () => {
    const { base } = await ownerWithCommunity();
    const other = await createCommunity(harness, { owner: 'other-owner', name: 'Other' });
    const response = await harness.request(
      'PATCH',
      `${base}/channels/${other.channels[0]!.id}`,
      { as: 'owner', body: { name: 'stolen' } },
    );
    expect(response.status).toBe(404);
  });
});

describe('permission overwrites', () => {
  test('the owner sets a role overwrite; audit + event recorded', async () => {
    const { community, base } = await ownerWithCommunity();
    const channelId = community.channels[0]!.id;
    const role = await addRole(harness, community.id, { name: 'Voice', position: 2 });

    const response = await harness.request(
      'PUT',
      `${base}/channels/${channelId}/permission-overwrites/role/${role}`,
      { as: 'owner', body: { allow: ['VIEW_CHANNEL'], deny: ['SEND_MESSAGES'] } },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      channel_id: channelId,
      target_type: 'role',
      target_id: role,
      allow: ['VIEW_CHANNEL'],
      deny: ['SEND_MESSAGES'],
    });

    const audit = harness.store.state.auditLog.at(-1);
    expect(audit?.action).toBe('permission_overwrite_set');
    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.eventType).toBe('permission_overwrites_changed');
    expect(event?.payload).toEqual({ community_id: community.id, channel_id: channelId });
  });

  test('upserting the same target twice keeps a single overwrite row', async () => {
    const { community, base } = await ownerWithCommunity();
    const channelId = community.channels[0]!.id;

    await harness.request(
      'PUT',
      `${base}/channels/${channelId}/permission-overwrites/member/member-1`,
      { as: 'owner', body: { allow: ['VIEW_CHANNEL'], deny: [] } },
    );
    const second = await harness.request(
      'PUT',
      `${base}/channels/${channelId}/permission-overwrites/member/member-1`,
      { as: 'owner', body: { allow: ['SEND_MESSAGES'], deny: ['VIEW_CHANNEL'] } },
    );

    expect(second.status).toBe(200);
    expect(harness.store.state.overwrites.size).toBe(1);
    expect(second.body.allow).toEqual(['SEND_MESSAGES']);
  });

  test('a permission cannot be both allowed and denied', async () => {
    const { community, base } = await ownerWithCommunity();
    const response = await harness.request(
      'PUT',
      `${base}/channels/${community.channels[0]!.id}/permission-overwrites/member/member-1`,
      { as: 'owner', body: { allow: ['VIEW_CHANNEL'], deny: ['VIEW_CHANNEL'] } },
    );
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_error');
  });

  test('a role overwrite also requires MANAGE_ROLES', async () => {
    const { community, base } = await ownerWithCommunity();
    const channelsRole = await addRole(harness, community.id, {
      name: 'Channel admin',
      position: 3,
      permissions: ['MANAGE_CHANNELS', 'VIEW_CHANNEL'],
    });
    await addMember(harness, community.id, 'channel-admin', [channelsRole]);
    const target = await addRole(harness, community.id, { name: 'Target', position: 1 });

    const roleTarget = await harness.request(
      'PUT',
      `${base}/channels/${community.channels[0]!.id}/permission-overwrites/role/${target}`,
      { as: 'channel-admin', body: { allow: ['VIEW_CHANNEL'], deny: [] } },
    );
    expect(roleTarget.status).toBe(403);
    expect(roleTarget.body.error.code).toBe('missing_permission');

    const memberTarget = await harness.request(
      'PUT',
      `${base}/channels/${community.channels[0]!.id}/permission-overwrites/member/member-9`,
      { as: 'channel-admin', body: { allow: ['VIEW_CHANNEL'], deny: [] } },
    );
    expect(memberTarget.status).toBe(200);
  });

  test('a moderator cannot grant a permission they do not hold', async () => {
    const { community, base } = await ownerWithCommunity();
    const moderatorRole = await addRole(harness, community.id, {
      name: 'Moderator',
      position: 4,
      permissions: ['MANAGE_CHANNELS', 'MANAGE_ROLES', 'VIEW_CHANNEL'],
    });
    await addMember(harness, community.id, 'mod-1', [moderatorRole]);

    const response = await harness.request(
      'PUT',
      `${base}/channels/${community.channels[0]!.id}/permission-overwrites/member/member-2`,
      { as: 'mod-1', body: { allow: ['BAN_MEMBERS'], deny: [] } },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('cannot_grant_unheld_permission');
  });

  test('an overwrite on a role at or above the actor position is rejected', async () => {
    const { community, base } = await ownerWithCommunity();
    const moderatorRole = await addRole(harness, community.id, {
      name: 'Moderator',
      position: 4,
      permissions: ['MANAGE_CHANNELS', 'MANAGE_ROLES'],
    });
    const higherRole = await addRole(harness, community.id, { name: 'Higher', position: 4 });
    await addMember(harness, community.id, 'mod-2', [moderatorRole]);

    const response = await harness.request(
      'PUT',
      `${base}/channels/${community.channels[0]!.id}/permission-overwrites/role/${higherRole}`,
      { as: 'mod-2', body: { allow: [], deny: ['VIEW_CHANNEL'] } },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('hierarchy_violation');
  });

  test('DELETE removes the overwrite and emits permission_overwrites_changed', async () => {
    const { community, base } = await ownerWithCommunity();
    const channelId = community.channels[0]!.id;
    await harness.request(
      'PUT',
      `${base}/channels/${channelId}/permission-overwrites/member/member-1`,
      { as: 'owner', body: { allow: ['VIEW_CHANNEL'], deny: [] } },
    );

    const response = await harness.request(
      'DELETE',
      `${base}/channels/${channelId}/permission-overwrites/member/member-1`,
      { as: 'owner' },
    );
    expect(response.status).toBe(204);
    expect(harness.store.state.overwrites.size).toBe(0);
    expect(harness.store.state.auditLog.at(-1)?.action).toBe('permission_overwrite_removed');
    expect([...harness.store.state.outbox.values()].at(-1)?.eventType).toBe(
      'permission_overwrites_changed',
    );
  });

  test('DELETE returns 404 when no overwrite exists', async () => {
    const { community, base } = await ownerWithCommunity();
    const response = await harness.request(
      'DELETE',
      `${base}/channels/${community.channels[0]!.id}/permission-overwrites/member/nobody`,
      { as: 'owner' },
    );
    expect(response.status).toBe(404);
  });
});
