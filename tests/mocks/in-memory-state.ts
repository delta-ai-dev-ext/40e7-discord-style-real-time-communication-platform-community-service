import type {
  AuditLogEntryRow,
  BanRow,
  ChannelRow,
  CommunityRow,
  EmailInviteRow,
  InviteRow,
  MemberRoleRow,
  MembershipRow,
  OutboxEventRow,
  PermissionOverwriteRow,
  RoleRow,
} from '../../src/models/domain.ts';

/**
 * Mutable state of the in-memory repository fake, plus the referential
 * integrity rules PostgreSQL enforces with FKs (`ON DELETE CASCADE`).
 */
export interface InMemoryState {
  communities: Map<string, CommunityRow>;
  channels: Map<string, ChannelRow>;
  roles: Map<string, RoleRow>;
  memberships: Map<string, MembershipRow>;
  memberRoles: Map<string, MemberRoleRow>;
  overwrites: Map<string, PermissionOverwriteRow>;
  bans: Map<string, BanRow>;
  invites: Map<string, InviteRow>;
  emailInvites: Map<string, EmailInviteRow>;
  auditLog: AuditLogEntryRow[];
  outbox: Map<string, OutboxEventRow>;
}

export const membershipKey = (communityId: string, userId: string) => `${communityId}|${userId}`;
export const memberRoleKey = (communityId: string, userId: string, roleId: string) =>
  `${communityId}|${userId}|${roleId}`;
export const overwriteKey = (channelId: string, targetType: string, targetId: string) =>
  `${channelId}|${targetType}|${targetId}`;

export function createEmptyState(): InMemoryState {
  return {
    communities: new Map(),
    channels: new Map(),
    roles: new Map(),
    memberships: new Map(),
    memberRoles: new Map(),
    overwrites: new Map(),
    bans: new Map(),
    invites: new Map(),
    emailInvites: new Map(),
    auditLog: [],
    outbox: new Map(),
  };
}

export function cloneState(state: InMemoryState): InMemoryState {
  return {
    communities: new Map(state.communities),
    channels: new Map(state.channels),
    roles: new Map(state.roles),
    memberships: new Map(state.memberships),
    memberRoles: new Map(state.memberRoles),
    overwrites: new Map(state.overwrites),
    bans: new Map(state.bans),
    invites: new Map(state.invites),
    emailInvites: new Map(state.emailInvites),
    auditLog: state.auditLog.map((entry) => ({ ...entry })),
    outbox: new Map(state.outbox),
  };
}

export function restoreState(target: InMemoryState, snapshot: InMemoryState): void {
  target.communities = snapshot.communities;
  target.channels = snapshot.channels;
  target.roles = snapshot.roles;
  target.memberships = snapshot.memberships;
  target.memberRoles = snapshot.memberRoles;
  target.overwrites = snapshot.overwrites;
  target.bans = snapshot.bans;
  target.invites = snapshot.invites;
  target.emailInvites = snapshot.emailInvites;
  target.auditLog = snapshot.auditLog;
  target.outbox = snapshot.outbox;
}

/** Community deletion cascades to every dependent table (docs/architecture.md §5). */
export function cascadeCommunity(state: InMemoryState, communityId: string): void {
  const channelIds = [...state.channels.values()]
    .filter((channel) => channel.communityId === communityId)
    .map((channel) => channel.id);
  const roleIds = [...state.roles.values()]
    .filter((role) => role.communityId === communityId)
    .map((role) => role.id);

  for (const channelId of channelIds) state.channels.delete(channelId);
  for (const roleId of roleIds) state.roles.delete(roleId);
  for (const [key, invite] of [...state.invites]) {
    if (invite.communityId === communityId) state.invites.delete(key);
  }
  for (const [key, invite] of [...state.emailInvites]) {
    if (invite.communityId === communityId) state.emailInvites.delete(key);
  }
  for (const [key, membership] of [...state.memberships]) {
    if (membership.communityId === communityId) state.memberships.delete(key);
  }
  for (const [key, assignment] of [...state.memberRoles]) {
    if (assignment.communityId === communityId) state.memberRoles.delete(key);
  }
  for (const [key, overwrite] of [...state.overwrites]) {
    if (channelIds.includes(overwrite.channelId)) state.overwrites.delete(key);
  }
  for (const [key, ban] of [...state.bans]) {
    if (ban.communityId === communityId) state.bans.delete(key);
  }
  // `audit_log_entry` cascades with the community (FK), but `outbox_event` has
  // no FK: the deletion event must still be publishable after the commit.
  state.auditLog = state.auditLog.filter((entry) => entry.communityId !== communityId);
}

export function sortByDate<T>(
  rows: T[],
  date: (row: T) => Date,
  direction: 'asc' | 'desc',
  id: (row: T) => string,
): T[] {
  return [...rows].sort((a, b) => {
    const delta = date(a).getTime() - date(b).getTime();
    if (delta !== 0) return direction === 'asc' ? delta : -delta;
    return direction === 'asc' ? id(a).localeCompare(id(b)) : id(b).localeCompare(id(a));
  });
}
