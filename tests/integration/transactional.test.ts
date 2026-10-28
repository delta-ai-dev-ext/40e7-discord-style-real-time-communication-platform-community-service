import { beforeEach, describe, expect, test } from 'bun:test';
import { addMember, addRole, createCommunity, createHarness, type TestHarness } from '../mocks/harness.ts';

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

describe('transaction boundaries (ADR-0001)', () => {
  test('state change, audit entry and outbox row commit together', async () => {
    const community = await createCommunity(harness);
    const base = `/v1/communities/${community.id}`;
    await addMember(harness, community.id, 'member-1');

    await harness.request('POST', `${base}/channels`, {
      as: 'owner',
      body: { name: 'announcements', type: 'text' },
    });

    expect(harness.store.transactionCount.committed).toBeGreaterThan(0);
    expect(harness.store.transactionCount.rolledBack).toBe(0);
    expect(harness.store.state.channels.size).toBe(3);
    expect(harness.store.state.auditLog).toHaveLength(1);
    expect(harness.store.state.outbox.size).toBe(1);
  });

  test('a rolled-back transaction leaves no partial state', async () => {
    const community = await createCommunity(harness);
    const channelsBefore = harness.store.state.channels.size;

    await expect(
      harness.store.withTransaction(async (tx) => {
        await tx.channel.insert({
          id: 'temp-channel',
          communityId: community.id,
          name: 'temp',
          type: 'text',
          position: 9,
          createdAt: harness.now(),
          updatedAt: harness.now(),
        });
        await tx.auditLog.insert({
          id: 'temp-audit',
          communityId: community.id,
          actorUserId: 'owner',
          action: 'channel_created',
          target: 'temp-channel',
          reason: null,
          changes: {},
          createdAt: harness.now(),
        });
        throw new Error('commit failure');
      }),
    ).rejects.toThrow('commit failure');

    expect(harness.store.transactionCount.rolledBack).toBe(1);
    expect(harness.store.state.channels.size).toBe(channelsBefore);
    expect(harness.store.state.auditLog).toHaveLength(0);
  });

  test('a rejected action writes neither audit nor outbox rows', async () => {
    const community = await createCommunity(harness);
    const base = `/v1/communities/${community.id}`;
    const viewerRole = await addRole(harness, community.id, {
      name: 'Viewer',
      position: 1,
      permissions: ['VIEW_CHANNEL'],
    });
    await addMember(harness, community.id, 'viewer', [viewerRole]);

    const committedBefore = harness.store.transactionCount.committed;
    const response = await harness.request('POST', `${base}/moderation/bans`, {
      as: 'viewer',
      body: { user_id: 'owner', reason: 'nope' },
    });
    expect(response.status).toBe(403);
    expect(harness.store.state.auditLog).toHaveLength(0);
    expect(harness.store.state.outbox.size).toBe(0);
    expect(harness.store.transactionCount.committed).toBe(committedBefore);
  });

  test('a failed invite acceptance rolls the membership insert back', async () => {
    const community = await createCommunity(harness);
    const base = `/v1/communities/${community.id}`;
    const everyone = await harness.store.repositories.role.findEveryone(community.id);
    await harness.store.repositories.role.update(everyone!.id, {
      permissions: ['CREATE_INVITE', 'VIEW_CHANNEL'],
      updatedAt: harness.now(),
    });
    await addMember(harness, community.id, 'inviter');

    const invite = await harness.request('POST', `${base}/invites`, {
      as: 'inviter',
      body: { max_uses: 1 },
    });
    const code = invite.body.code as string;

    const first = await harness.request('POST', `/v1/invites/${code}/accept`, { as: 'joiner-1' });
    expect(first.status).toBe(201);

    const second = await harness.request('POST', `/v1/invites/${code}/accept`, { as: 'joiner-2' });
    expect(second.status).toBe(410);
    expect(await harness.store.repositories.membership.find(community.id, 'joiner-2')).toBeNull();

    const stored = await harness.store.repositories.invite.findByCode(code);
    expect(stored?.usedCount).toBe(1);
    expect(harness.store.transactionCount.rolledBack).toBe(1);
  });

  test('idempotent acceptance commits without emitting a duplicate event', async () => {
    const community = await createCommunity(harness);
    const base = `/v1/communities/${community.id}`;
    const everyone = await harness.store.repositories.role.findEveryone(community.id);
    await harness.store.repositories.role.update(everyone!.id, {
      permissions: ['CREATE_INVITE', 'VIEW_CHANNEL'],
      updatedAt: harness.now(),
    });
    await addMember(harness, community.id, 'inviter');

    const invite = await harness.request('POST', `${base}/invites`, { as: 'inviter' });
    const code = invite.body.code as string;

    await harness.request('POST', `/v1/invites/${code}/accept`, { as: 'joiner' });
    const eventsAfterJoin = harness.store.state.outbox.size;

    const repeat = await harness.request('POST', `/v1/invites/${code}/accept`, { as: 'joiner' });
    expect(repeat.status).toBe(200);
    expect(harness.store.state.outbox.size).toBe(eventsAfterJoin);
  });

  test('every mutation path emits a matching audit action vocabulary entry', async () => {
    const community = await createCommunity(harness);
    const base = `/v1/communities/${community.id}`;
    await addMember(harness, community.id, 'member-1');

    await harness.request('PATCH', base, { as: 'owner', body: { name: 'Renamed' } });
    await harness.request('POST', `${base}/roles`, {
      as: 'owner',
      body: { name: 'Fan', permissions: ['VIEW_CHANNEL'], position: 1 },
    });
    await harness.request('POST', `${base}/moderation/timeouts`, {
      as: 'owner',
      body: { user_id: 'member-1', duration_seconds: 60, reason: 'shhh' },
    });
    await harness.request('DELETE', `${base}/moderation/timeouts/member-1`, { as: 'owner' });
    await harness.request('POST', `${base}/moderation/kicks`, {
      as: 'owner',
      body: { user_id: 'member-1', reason: 'bye' },
    });

    const actions = harness.store.state.auditLog.map((entry) => entry.action);
    expect(actions).toEqual([
      'community_renamed',
      'role_created',
      'member_timed_out',
      'member_timeout_cleared',
      'member_kicked',
    ]);
    // Every audited change also produced exactly one outbox event, except the
    // role change which emits roles_changed — still one row per change.
    expect(harness.store.state.outbox.size).toBe(5);
  });
});
