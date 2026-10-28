import { beforeEach, describe, expect, test } from 'bun:test';
import { addMember, addRole, createCommunity, createHarness, type TestHarness } from '../mocks/harness.ts';

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

async function fixture() {
  const community = await createCommunity(harness);
  const base = `/v1/communities/${community.id}`;
  return { community, base };
}

describe('GET /v1/communities/:id/members', () => {
  test('lists members with their role ids', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, { name: 'Fan', position: 1 });
    await addMember(harness, community.id, 'member-1', [roleId]);

    const response = await harness.request('GET', `${base}/members`, { as: 'owner' });
    expect(response.status).toBe(200);
    expect(response.body.members).toHaveLength(2);
    const member = response.body.members.find((entry: { user_id: string }) => entry.user_id === 'member-1');
    expect(member.roles).toEqual([roleId]);
    expect(member.nickname).toBeNull();
    expect(response.body.next_cursor).toBeNull();
  });

  test('paginates with limit and the opaque cursor', async () => {
    const { community, base } = await fixture();
    for (const user of ['member-1', 'member-2', 'member-3']) {
      harness.setNow(new Date(harness.now().getTime() + 1000));
      await addMember(harness, community.id, user);
    }

    const first = await harness.request('GET', `${base}/members?limit=2`, { as: 'owner' });
    expect(first.status).toBe(200);
    expect(first.body.members).toHaveLength(2);
    expect(first.body.next_cursor).toBeTruthy();

    const second = await harness.request(
      'GET',
      `${base}/members?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
      { as: 'owner' },
    );
    expect(second.status).toBe(200);
    expect(second.body.members).toHaveLength(2);
    expect(second.body.next_cursor).toBeNull();
    const ids = [...first.body.members, ...second.body.members].map(
      (entry: { user_id: string }) => entry.user_id,
    );
    expect(new Set(ids).size).toBe(4);
  });

  test('requires membership', async () => {
    const { base } = await fixture();
    const response = await harness.request('GET', `${base}/members`, { as: 'outsider' });
    expect(response.status).toBe(403);
  });
});

describe('PATCH /v1/communities/:id/members/me', () => {
  test('sets and clears the caller nickname', async () => {
    const { community, base } = await fixture();
    await addMember(harness, community.id, 'member-1');

    const set = await harness.request('PATCH', `${base}/members/me`, {
      as: 'member-1',
      body: { nickname: 'Ace' },
    });
    expect(set.status).toBe(200);
    expect(set.body.nickname).toBe('Ace');
    expect(set.body.user_id).toBe('member-1');

    const cleared = await harness.request('PATCH', `${base}/members/me`, {
      as: 'member-1',
      body: { nickname: null },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.nickname).toBeNull();
  });

  test('rejects a nickname longer than 32 characters', async () => {
    const { community, base } = await fixture();
    await addMember(harness, community.id, 'member-1');
    const response = await harness.request('PATCH', `${base}/members/me`, {
      as: 'member-1',
      body: { nickname: 'x'.repeat(33) },
    });
    expect(response.status).toBe(400);
  });

  test('a non-member cannot set a nickname', async () => {
    const { base } = await fixture();
    const response = await harness.request('PATCH', `${base}/members/me`, {
      as: 'outsider',
      body: { nickname: 'Ghost' },
    });
    expect(response.status).toBe(403);
  });
});

describe('DELETE /v1/communities/:id/members/me', () => {
  test('leave removes the membership and role assignments and emits member_left', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, { name: 'Fan', position: 1 });
    await addMember(harness, community.id, 'member-1', [roleId]);

    const response = await harness.request('DELETE', `${base}/members/me`, { as: 'member-1' });
    expect(response.status).toBe(204);
    expect(await harness.store.repositories.membership.find(community.id, 'member-1')).toBeNull();
    expect(harness.store.state.memberRoles.size).toBe(0);

    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.eventType).toBe('member_left');
    expect(event?.payload).toEqual({ community_id: community.id, user_id: 'member-1' });
  });

  test('the owner cannot leave their own community', async () => {
    const { base } = await fixture();
    const response = await harness.request('DELETE', `${base}/members/me`, { as: 'owner' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('owner_cannot_leave');
  });

  test('a non-member cannot leave', async () => {
    const { base } = await fixture();
    const response = await harness.request('DELETE', `${base}/members/me`, { as: 'outsider' });
    expect(response.status).toBe(403);
  });
});

describe('PUT/DELETE /v1/communities/:id/members/:user_id/roles/:role_id', () => {
  test('assigns a role, writes audit and emits member_roles_changed', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, { name: 'Fan', position: 1 });
    await addMember(harness, community.id, 'member-1');

    const response = await harness.request(
      'PUT',
      `${base}/members/member-1/roles/${roleId}`,
      { as: 'owner' },
    );
    expect(response.status).toBe(204);

    const audit = harness.store.state.auditLog.at(-1);
    expect(audit?.action).toBe('member_role_assigned');
    expect(audit?.target).toBe('member-1');
    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.eventType).toBe('member_roles_changed');
    expect(event?.payload).toEqual({
      community_id: community.id,
      user_id: 'member-1',
      role_ids: [roleId],
    });
  });

  test('assigning the same role twice is idempotent', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, { name: 'Fan', position: 1 });
    await addMember(harness, community.id, 'member-1');

    await harness.request('PUT', `${base}/members/member-1/roles/${roleId}`, { as: 'owner' });
    const second = await harness.request('PUT', `${base}/members/member-1/roles/${roleId}`, {
      as: 'owner',
    });
    expect(second.status).toBe(204);
    expect(harness.store.state.memberRoles.size).toBe(1);
  });

  test('the @everyone role cannot be assigned', async () => {
    const { community, base } = await fixture();
    const everyone = await harness.store.repositories.role.findEveryone(community.id);
    await addMember(harness, community.id, 'member-1');

    const response = await harness.request(
      'PUT',
      `${base}/members/member-1/roles/${everyone!.id}`,
      { as: 'owner' },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('protected_role');
  });

  test('the owner cannot be targeted', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, { name: 'Fan', position: 1 });
    const response = await harness.request(
      'PUT',
      `${base}/members/owner/roles/${roleId}`,
      { as: 'owner' },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('owner_protected');
  });

  test('a role above the actor is protected', async () => {
    const { community, base } = await fixture();
    const managerRole = await addRole(harness, community.id, {
      name: 'Manager',
      position: 5,
      permissions: ['MANAGE_ROLES'],
    });
    const highRole = await addRole(harness, community.id, { name: 'High', position: 6 });
    await addMember(harness, community.id, 'manager', [managerRole]);
    await addMember(harness, community.id, 'member-1');

    const response = await harness.request(
      'PUT',
      `${base}/members/member-1/roles/${highRole}`,
      { as: 'manager' },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('hierarchy_violation');
  });

  test('a role carrying unheld permissions cannot be granted', async () => {
    const { community, base } = await fixture();
    const managerRole = await addRole(harness, community.id, {
      name: 'Manager',
      position: 5,
      permissions: ['MANAGE_ROLES'],
    });
    const dangerousRole = await addRole(harness, community.id, {
      name: 'Dangerous',
      position: 2,
      permissions: ['BAN_MEMBERS'],
    });
    await addMember(harness, community.id, 'manager', [managerRole]);
    await addMember(harness, community.id, 'member-1');

    const response = await harness.request(
      'PUT',
      `${base}/members/member-1/roles/${dangerousRole}`,
      { as: 'manager' },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('cannot_grant_unheld_permission');
  });

  test('assigning to a non-member returns 404', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, { name: 'Fan', position: 1 });
    const response = await harness.request(
      'PUT',
      `${base}/members/ghost/roles/${roleId}`,
      { as: 'owner' },
    );
    expect(response.status).toBe(404);
  });

  test('removes a role with audit + event', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, { name: 'Fan', position: 1 });
    await addMember(harness, community.id, 'member-1', [roleId]);

    const response = await harness.request(
      'DELETE',
      `${base}/members/member-1/roles/${roleId}`,
      { as: 'owner' },
    );
    expect(response.status).toBe(204);
    expect(harness.store.state.memberRoles.size).toBe(0);
    expect(harness.store.state.auditLog.at(-1)?.action).toBe('member_role_removed');
    expect([...harness.store.state.outbox.values()].at(-1)?.eventType).toBe('member_roles_changed');
  });

  test('removing an unassigned role returns 404', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, { name: 'Fan', position: 1 });
    await addMember(harness, community.id, 'member-1');

    const response = await harness.request(
      'DELETE',
      `${base}/members/member-1/roles/${roleId}`,
      { as: 'owner' },
    );
    expect(response.status).toBe(404);
  });

  test('a member without MANAGE_ROLES cannot assign roles', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, { name: 'Fan', position: 1 });
    await addMember(harness, community.id, 'member-1');
    await addMember(harness, community.id, 'member-2');

    const response = await harness.request(
      'PUT',
      `${base}/members/member-2/roles/${roleId}`,
      { as: 'member-1' },
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('missing_permission');
  });
});
