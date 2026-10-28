import { beforeEach, describe, expect, test } from 'bun:test';
import { addMember, addRole, createCommunity, createHarness, type TestHarness } from '../mocks/harness.ts';

let harness: TestHarness;

beforeEach(() => {
  harness = createHarness();
});

async function fixture() {
  const community = await createCommunity(harness);
  const everyone = await harness.store.repositories.role.findEveryone(community.id);
  return { community, everyone: everyone!, base: `/v1/communities/${community.id}` };
}

describe('GET /v1/communities/:id/roles', () => {
  test('lists roles ordered by position, highest first', async () => {
    const { community, base } = await fixture();
    await addRole(harness, community.id, { name: 'Low', position: 1 });
    await addRole(harness, community.id, { name: 'High', position: 9 });
    await addMember(harness, community.id, 'member-1');

    const response = await harness.request('GET', `${base}/roles`, { as: 'member-1' });
    expect(response.status).toBe(200);
    expect(response.body.roles.map((role: { name: string }) => role.name)).toEqual([
      'High',
      'Low',
      '@everyone',
    ]);
  });

  test('requires membership', async () => {
    const { base } = await fixture();
    const response = await harness.request('GET', `${base}/roles`, { as: 'outsider' });
    expect(response.status).toBe(403);
  });
});

describe('POST /v1/communities/:id/roles', () => {
  test('the owner creates a role with audit + roles_changed', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/roles`, {
      as: 'owner',
      body: { name: 'DJ', permissions: ['VIEW_CHANNEL', 'SPEAK'], position: 3 },
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      name: 'DJ',
      permissions: ['VIEW_CHANNEL', 'SPEAK'],
      position: 3,
      is_everyone: false,
    });
    expect(harness.store.state.auditLog.at(-1)?.action).toBe('role_created');
    const event = [...harness.store.state.outbox.values()].at(-1);
    expect(event?.eventType).toBe('roles_changed');
    expect(event?.payload).toEqual({ community_id: response.body.community_id, role_id: response.body.id });
  });

  test('rejects unknown permission values with a validation error', async () => {
    const { base } = await fixture();
    const response = await harness.request('POST', `${base}/roles`, {
      as: 'owner',
      body: { name: 'Bad', permissions: ['MANAGE_EVERYTHING'], position: 1 },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
  });

  test('a moderator cannot create a role at or above their own position', async () => {
    const { community, base } = await fixture();
    const managerRole = await addRole(harness, community.id, {
      name: 'Manager',
      position: 5,
      permissions: ['MANAGE_ROLES'],
    });
    await addMember(harness, community.id, 'manager', [managerRole]);

    const equal = await harness.request('POST', `${base}/roles`, {
      as: 'manager',
      body: { name: 'Equal', permissions: [], position: 5 },
    });
    expect(equal.status).toBe(403);
    expect(equal.body.error.code).toBe('hierarchy_violation');

    const higher = await harness.request('POST', `${base}/roles`, {
      as: 'manager',
      body: { name: 'Higher', permissions: [], position: 6 },
    });
    expect(higher.status).toBe(403);

    const lower = await harness.request('POST', `${base}/roles`, {
      as: 'manager',
      body: { name: 'Lower', permissions: [], position: 4 },
    });
    expect(lower.status).toBe(201);
  });

  test('a non-privileged manager cannot grant permissions they lack', async () => {
    const { community, base } = await fixture();
    const managerRole = await addRole(harness, community.id, {
      name: 'Manager',
      position: 5,
      permissions: ['MANAGE_ROLES'],
    });
    await addMember(harness, community.id, 'manager', [managerRole]);

    const response = await harness.request('POST', `${base}/roles`, {
      as: 'manager',
      body: { name: 'Sneaky', permissions: ['BAN_MEMBERS'], position: 1 },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('cannot_grant_unheld_permission');
  });

  test('a member without MANAGE_ROLES is rejected', async () => {
    const { community, base } = await fixture();
    await addMember(harness, community.id, 'member-1');
    const response = await harness.request('POST', `${base}/roles`, {
      as: 'member-1',
      body: { name: 'Nope', permissions: [], position: 1 },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('missing_permission');
  });
});

describe('PATCH/DELETE /v1/communities/:id/roles/:role_id', () => {
  test('updates a role and records before/after in the audit entry', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, {
      name: 'Old',
      position: 2,
      permissions: ['VIEW_CHANNEL'],
    });

    const response = await harness.request('PATCH', `${base}/roles/${roleId}`, {
      as: 'owner',
      body: { name: 'New', permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'], position: 3 },
    });
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('New');
    expect(response.body.permissions).toEqual(['VIEW_CHANNEL', 'SEND_MESSAGES']);

    const audit = harness.store.state.auditLog.at(-1);
    expect(audit?.action).toBe('role_updated');
    expect((audit?.changes as { permissions_added: string[] }).permissions_added).toEqual([
      'SEND_MESSAGES',
    ]);
    expect([...harness.store.state.outbox.values()].at(-1)?.eventType).toBe('roles_changed');
  });

  test('the @everyone role cannot be modified or deleted', async () => {
    const { base, everyone } = await fixture();
    const patched = await harness.request('PATCH', `${base}/roles/${everyone.id}`, {
      as: 'owner',
      body: { name: 'Renamed' },
    });
    expect(patched.status).toBe(403);
    expect(patched.body.error.code).toBe('protected_role');

    const deleted = await harness.request('DELETE', `${base}/roles/${everyone.id}`, { as: 'owner' });
    expect(deleted.status).toBe(403);
    expect(deleted.body.error.code).toBe('protected_role');
  });

  test('a manager cannot modify a role above them', async () => {
    const { community, base } = await fixture();
    const managerRole = await addRole(harness, community.id, {
      name: 'Manager',
      position: 5,
      permissions: ['MANAGE_ROLES'],
    });
    const target = await addRole(harness, community.id, { name: 'Target', position: 7 });
    await addMember(harness, community.id, 'manager', [managerRole]);

    const response = await harness.request('PATCH', `${base}/roles/${target}`, {
      as: 'manager',
      body: { name: 'Renamed' },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('hierarchy_violation');
  });

  test('cannot raise a role above your own position', async () => {
    const { community, base } = await fixture();
    const managerRole = await addRole(harness, community.id, {
      name: 'Manager',
      position: 5,
      permissions: ['MANAGE_ROLES'],
    });
    const target = await addRole(harness, community.id, { name: 'Target', position: 2 });
    await addMember(harness, community.id, 'manager', [managerRole]);

    const response = await harness.request('PATCH', `${base}/roles/${target}`, {
      as: 'manager',
      body: { position: 9 },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('hierarchy_violation');
  });

  test('deleting a role removes assignments and emits roles_changed', async () => {
    const { community, base } = await fixture();
    const roleId = await addRole(harness, community.id, { name: 'Temp', position: 1 });
    await addMember(harness, community.id, 'member-1', [roleId]);

    const response = await harness.request('DELETE', `${base}/roles/${roleId}`, { as: 'owner' });
    expect(response.status).toBe(204);
    expect(harness.store.state.memberRoles.size).toBe(0);
    expect(harness.store.state.auditLog.at(-1)?.action).toBe('role_deleted');
    expect([...harness.store.state.outbox.values()].at(-1)?.eventType).toBe('roles_changed');
  });

  test('returns 404 for a role of another community', async () => {
    const { base } = await fixture();
    const other = await createCommunity(harness, { owner: 'other', name: 'Other' });
    const otherRole = await addRole(harness, other.id, { name: 'Foreign', position: 1 });
    const response = await harness.request('DELETE', `${base}/roles/${otherRole}`, { as: 'owner' });
    expect(response.status).toBe(404);
  });
});
