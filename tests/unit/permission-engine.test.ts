import { describe, expect, test } from 'bun:test';
import { ALL_PERMISSIONS, type Permission } from '../../src/models/permissions.ts';
import {
  basePermissions,
  channelAccessFlags,
  highestRolePosition,
  resolveChannelPermissions,
  resolveCommunityPermissions,
  sortPermissions,
  type EngineOverwrite,
  type EngineRole,
  type EngineSubject,
} from '../../src/services/permission-engine.ts';

const everyone: EngineRole = {
  id: 'role-everyone',
  position: 0,
  permissions: ['VIEW_CHANNEL'],
  isEveryone: true,
};
const moderator: EngineRole = {
  id: 'role-mod',
  position: 10,
  permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'KICK_MEMBERS', 'MANAGE_ROLES'],
  isEveryone: false,
};
const admin: EngineRole = {
  id: 'role-admin',
  position: 50,
  permissions: ['ADMINISTRATOR'],
  isEveryone: false,
};
const muted: EngineRole = {
  id: 'role-muted',
  position: 1,
  permissions: [],
  isEveryone: false,
};

const roles = [everyone, muted, moderator, admin];

function subject(overrides: Partial<EngineSubject> = {}): EngineSubject {
  return { userId: 'user-1', isOwner: false, roleIds: [], isMember: true, ...overrides };
}

const sorted = (permissions: Set<Permission>) => sortPermissions(permissions);

describe('permission engine — base permissions', () => {
  test('@everyone applies to every member without explicit assignments', () => {
    expect(sorted(resolveCommunityPermissions(subject(), roles))).toEqual(['VIEW_CHANNEL']);
  });

  test('base permissions are the union of all assigned roles plus @everyone', () => {
    const permissions = resolveCommunityPermissions(subject({ roleIds: ['role-mod'] }), roles);
    expect(sorted(permissions)).toEqual([
      'VIEW_CHANNEL',
      'SEND_MESSAGES',
      'MANAGE_ROLES',
      'KICK_MEMBERS',
    ]);
  });

  test('the owner implicitly holds every permission', () => {
    expect(sorted(resolveCommunityPermissions(subject({ isOwner: true }), roles))).toEqual([
      ...ALL_PERMISSIONS,
    ]);
  });

  test('ADMINISTRATOR grants every permission', () => {
    expect(sorted(resolveCommunityPermissions(subject({ roleIds: ['role-admin'] }), roles))).toEqual([
      ...ALL_PERMISSIONS,
    ]);
  });

  test('unknown permission strings are ignored', () => {
    const polluted: EngineRole = { ...moderator, permissions: ['VIEW_CHANNEL', 'NOT_A_PERMISSION'] };
    const base = basePermissions(subject({ roleIds: ['role-mod'] }), [everyone, polluted]);
    expect(base).not.toBe('all');
    expect(sorted(base as Set<Permission>)).toEqual(['VIEW_CHANNEL']);
  });
});

describe('permission engine — channel resolution order', () => {
  const everyoneOverwrite: EngineOverwrite = {
    targetType: 'role',
    targetId: 'role-everyone',
    allow: [],
    deny: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
  };
  const roleOverwrite: EngineOverwrite = {
    targetType: 'role',
    targetId: 'role-mod',
    allow: ['SEND_MESSAGES'],
    deny: [],
  };
  const memberOverwrite: EngineOverwrite = {
    targetType: 'member',
    targetId: 'user-1',
    allow: ['READ_MESSAGE_HISTORY'],
    deny: [],
  };

  test('no overwrites ⇒ base role permissions', () => {
    expect(sorted(resolveChannelPermissions(subject({ roleIds: ['role-mod'] }), roles, []))).toEqual([
      'VIEW_CHANNEL',
      'SEND_MESSAGES',
      'MANAGE_ROLES',
      'KICK_MEMBERS',
    ]);
  });

  test('@everyone overwrite is applied before role overwrites', () => {
    const permissions = resolveChannelPermissions(
      subject({ roleIds: ['role-mod'] }),
      roles,
      [everyoneOverwrite, roleOverwrite],
    );
    // everyone denies VIEW_CHANNEL + SEND_MESSAGES, then the role allows SEND_MESSAGES back.
    expect(sorted(permissions)).toEqual(['SEND_MESSAGES', 'MANAGE_ROLES', 'KICK_MEMBERS']);
  });

  test('member overwrite wins last (most specific)', () => {
    const permissions = resolveChannelPermissions(subject({ roleIds: ['role-mod'] }), roles, [
      everyoneOverwrite,
      memberOverwrite,
    ]);
    expect(sorted(permissions)).toEqual(['READ_MESSAGE_HISTORY', 'MANAGE_ROLES', 'KICK_MEMBERS']);
  });

  test('a member overwrite can allow what @everyone denies', () => {
    const permissions = resolveChannelPermissions(subject(), roles, [
      everyoneOverwrite,
      { targetType: 'member', targetId: 'user-1', allow: ['VIEW_CHANNEL'], deny: [] },
    ]);
    expect(permissions.has('VIEW_CHANNEL')).toBe(true);
  });

  test('overwrites of roles the member does not hold are ignored', () => {
    const permissions = resolveChannelPermissions(subject(), roles, [
      { targetType: 'role', targetId: 'role-admin', allow: ['BAN_MEMBERS'], deny: [] },
    ]);
    expect(permissions.has('BAN_MEMBERS')).toBe(false);
  });

  test('overwrites of another member do not leak', () => {
    const permissions = resolveChannelPermissions(subject(), roles, [
      { targetType: 'member', targetId: 'user-2', allow: ['BAN_MEMBERS'], deny: [] },
    ]);
    expect(permissions.has('BAN_MEMBERS')).toBe(false);
  });

  test('owner bypasses every channel overwrite', () => {
    const permissions = resolveChannelPermissions(subject({ isOwner: true }), roles, [
      everyoneOverwrite,
      { targetType: 'member', targetId: 'user-1', allow: [], deny: [...ALL_PERMISSIONS] },
    ]);
    expect(sorted(permissions)).toEqual([...ALL_PERMISSIONS]);
  });

  test('ADMINISTRATOR bypasses every channel overwrite', () => {
    const permissions = resolveChannelPermissions(subject({ roleIds: ['role-admin'] }), roles, [
      everyoneOverwrite,
    ]);
    expect(sorted(permissions)).toEqual([...ALL_PERMISSIONS]);
  });
});

describe('permission engine — access flags', () => {
  const all = new Set<Permission>(ALL_PERMISSIONS);

  test('full permissions produce all flags for a healthy member', () => {
    expect(channelAccessFlags(all, { isMember: true, banned: false, timedOut: false })).toEqual({
      can_view: true,
      can_read_history: true,
      can_send: true,
      can_connect: true,
      can_speak: true,
      can_video: true,
    });
  });

  test('a timeout blocks send/speak/video but keeps view, history and connect', () => {
    const flags = channelAccessFlags(all, { isMember: true, banned: false, timedOut: true });
    expect(flags).toEqual({
      can_view: true,
      can_read_history: true,
      can_send: false,
      can_connect: true,
      can_speak: false,
      can_video: false,
    });
  });

  test('non-members and banned users are denied everything', () => {
    const denied = {
      can_view: false,
      can_read_history: false,
      can_send: false,
      can_connect: false,
      can_speak: false,
      can_video: false,
    };
    expect(channelAccessFlags(all, { isMember: false, banned: false, timedOut: false })).toEqual(denied);
    expect(channelAccessFlags(all, { isMember: true, banned: true, timedOut: false })).toEqual(denied);
  });

  test('voice flags require CONNECT and VIEW_CHANNEL', () => {
    const speakOnly = new Set<Permission>(['SPEAK', 'VIDEO'] as Permission[]);
    const flags = channelAccessFlags(speakOnly, { isMember: true, banned: false, timedOut: false });
    expect(flags.can_speak).toBe(false);
    expect(flags.can_video).toBe(false);
  });

  test('history requires VIEW_CHANNEL as well', () => {
    const historyOnly = new Set<Permission>(['READ_MESSAGE_HISTORY'] as Permission[]);
    expect(
      channelAccessFlags(historyOnly, { isMember: true, banned: false, timedOut: false }).can_read_history,
    ).toBe(false);
  });
});

describe('permission engine — hierarchy helper', () => {
  test('highest assigned role position ignores unassigned roles', () => {
    expect(highestRolePosition(subject({ roleIds: ['role-mod', 'role-muted'] }), roles)).toBe(10);
  });

  test('members with no roles resolve to -1', () => {
    expect(highestRolePosition(subject(), roles)).toBe(-1);
  });
});
