import { beforeEach, describe, expect, test } from 'bun:test';
import { addMember, addRole, createCommunity, createHarness, type TestHarness } from '../mocks/harness.ts';

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

describe('POST /v1/communities', () => {
  test('creates the community with defaults and the owner membership', async () => {
    const response = await harness.request('POST', '/v1/communities', {
      as: 'owner',
      body: { name: 'Creators' },
    });

    expect(response.status).toBe(201);
    expect(response.body.name).toBe('Creators');
    expect(response.body.owner_user_id).toBe('owner');
    expect(response.body.channels).toHaveLength(2);
    expect(response.body.channels[0].name).toBe('general');
    expect(response.body.channels[0].type).toBe('text');
    expect(response.body.channels[1].name).toBe('General');
    expect(response.body.channels[1].type).toBe('voice');
    expect(response.body.effective_permissions).toContain('ADMINISTRATOR');

    const everyone = await harness.store.repositories.role.findEveryone(response.body.id);
    expect(everyone?.isEveryone).toBe(true);
    expect(everyone?.name).toBe('@everyone');

    const membership = await harness.store.repositories.membership.find(response.body.id, 'owner');
    expect(membership?.userId).toBe('owner');

    const created = harness.metrics.communityCreated;
    expect((await created.get()).values[0]?.value).toBe(1);
  });

  test('rejects a blank name with a validation error and creates nothing', async () => {
    const response = await harness.request('POST', '/v1/communities', {
      as: 'owner',
      body: { name: '' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(harness.store.state.communities.size).toBe(0);
  });

  test('rejects a name longer than 100 characters', async () => {
    const response = await harness.request('POST', '/v1/communities', {
      as: 'owner',
      body: { name: 'x'.repeat(101) },
    });
    expect(response.status).toBe(400);
  });

  test('requires authentication', async () => {
    const response = await harness.request('POST', '/v1/communities', { body: { name: 'No auth' } });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  test('rejects an invalid token', async () => {
    const response = await harness.request('POST', '/v1/communities', {
      token: 'not-a-test-token',
      body: { name: 'Nope' },
    });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_token');
  });
});

describe('GET /v1/me/communities', () => {
  test('lists memberships with visible channels only', async () => {
    const community = await createCommunity(harness);
    await addMember(harness, community.id, 'member-1');

    const response = await harness.request('GET', '/v1/me/communities', { as: 'member-1' });
    expect(response.status).toBe(200);
    expect(response.body.communities).toHaveLength(1);
    expect(response.body.communities[0].id).toBe(community.id);
    // @everyone has no permissions yet, so no channel is visible to the member.
    expect(response.body.communities[0].channels).toEqual([]);
    expect(response.body.communities[0].effective_permissions).toEqual([]);
  });

  test('shows channels the member may view', async () => {
    const community = await createCommunity(harness);
    const everyone = await harness.store.repositories.role.findEveryone(community.id);
    await harness.store.repositories.role.update(everyone!.id, {
      permissions: ['VIEW_CHANNEL'],
      updatedAt: harness.now(),
    });
    await addMember(harness, community.id, 'member-1');

    const response = await harness.request('GET', '/v1/me/communities', { as: 'member-1' });
    expect(response.body.communities[0].channels).toHaveLength(2);
  });
});

describe('GET /v1/communities/:id', () => {
  test('returns the community for a member', async () => {
    const community = await createCommunity(harness);
    await addMember(harness, community.id, 'member-1');

    const response = await harness.request('GET', `/v1/communities/${community.id}`, { as: 'member-1' });
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(community.id);
  });

  test('rejects a non-member with 403', async () => {
    const community = await createCommunity(harness);
    const response = await harness.request('GET', `/v1/communities/${community.id}`, { as: 'stranger' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('not_a_member');
  });

  test('returns 404 for an unknown community', async () => {
    const response = await harness.request(
      'GET',
      '/v1/communities/00000000-0000-4000-8000-000000000000',
      { as: 'owner' },
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('not_found');
  });

  test('returns 400 for a malformed community id', async () => {
    const response = await harness.request('GET', '/v1/communities/not-a-uuid', { as: 'owner' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
  });
});

describe('PATCH /v1/communities/:id', () => {
  test('the owner renames and an audit entry plus event are written', async () => {
    const community = await createCommunity(harness, { name: 'Old name' });

    const response = await harness.request('PATCH', `/v1/communities/${community.id}`, {
      as: 'owner',
      body: { name: 'New name' },
    });
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('New name');

    const entries = harness.store.state.auditLog;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('community_renamed');
    expect(entries[0]?.actorUserId).toBe('owner');

    const outbox = [...harness.store.state.outbox.values()];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('community_updated');
    expect(outbox[0]?.payload).toEqual({ community_id: community.id, name: 'New name' });
    expect(outbox[0]?.topic).toBe('community_events');
    expect(outbox[0]?.partitionKey).toBe(community.id);
  });

  test('an ADMINISTRATOR who is not the owner is rejected', async () => {
    const community = await createCommunity(harness);
    const adminRole = await addRole(harness, community.id, {
      name: 'Admin',
      position: 5,
      permissions: ['ADMINISTRATOR'],
    });
    await addMember(harness, community.id, 'admin-1', [adminRole]);

    const response = await harness.request('PATCH', `/v1/communities/${community.id}`, {
      as: 'admin-1',
      body: { name: 'Hijacked' },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('owner_only');
    expect(harness.store.state.auditLog).toHaveLength(0);
  });
});

describe('DELETE /v1/communities/:id', () => {
  test('the owner deletes and community_deleted carries channel ids', async () => {
    const community = await createCommunity(harness);
    const channelIds = community.channels.map((channel) => channel.id);

    const response = await harness.request('DELETE', `/v1/communities/${community.id}`, { as: 'owner' });
    expect(response.status).toBe(204);

    const outbox = [...harness.store.state.outbox.values()];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.eventType).toBe('community_deleted');
    expect((outbox[0]?.payload as { channel_ids: string[] }).channel_ids.sort()).toEqual(
      [...channelIds].sort(),
    );

    expect(await harness.store.repositories.community.findById(community.id)).toBeNull();
    expect(harness.store.state.channels.size).toBe(0);
    expect(harness.store.state.memberships.size).toBe(0);
    expect(harness.store.state.roles.size).toBe(0);
  });

  test('a non-owner cannot delete', async () => {
    const community = await createCommunity(harness);
    await addMember(harness, community.id, 'member-1');
    const response = await harness.request('DELETE', `/v1/communities/${community.id}`, {
      as: 'member-1',
    });
    expect(response.status).toBe(403);
    expect(await harness.store.repositories.community.findById(community.id)).not.toBeNull();
  });
});
