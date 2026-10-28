import {
  ADMINISTRATOR,
  ALL_PERMISSIONS,
  isPermission,
  type Permission,
  normalizePermissions,
} from '../models/permissions.ts';

/**
 * Pure permission resolution engine (docs/architecture.md §3.2).
 *
 * Discord-style resolution order, most specific last:
 *   1. base role permissions (owner / ADMINISTRATOR ⇒ all permissions)
 *   2. channel `@everyone` overwrite
 *   3. the member's role overwrites on that channel
 *   4. the member's individual overwrite on that channel
 *
 * The engine has no I/O and no clock: callers pass already-loaded roles and
 * overwrites, which keeps it exhaustively unit-testable.
 */
export interface EngineRole {
  id: string;
  position: number;
  permissions: readonly string[];
  isEveryone: boolean;
}

export interface EngineOverwrite {
  targetType: 'role' | 'member';
  targetId: string;
  allow: readonly string[];
  deny: readonly string[];
}

export interface EngineSubject {
  userId: string;
  isOwner: boolean;
  /** Roles explicitly assigned to the member (never the `@everyone` role). */
  roleIds: readonly string[];
  isMember: boolean;
}

/** Sentinel returned when a subject holds every permission unconditionally. */
export const ALL = 'all' as const;

/**
 * Union of the subject's role permissions (including the implicit `@everyone`
 * role). Returns `ALL` for the owner or any holder of `ADMINISTRATOR`.
 */
export function basePermissions(
  subject: EngineSubject,
  roles: readonly EngineRole[],
): Set<Permission> | typeof ALL {
  if (subject.isOwner) return ALL;

  const granted = new Set<Permission>();
  for (const role of roles) {
    const applies = role.isEveryone || subject.roleIds.includes(role.id);
    if (!applies) continue;
    for (const permission of role.permissions) {
      if (isPermission(permission)) granted.add(permission);
    }
  }
  if (granted.has(ADMINISTRATOR)) return ALL;
  return granted;
}

/** Applies one allow/deny pair to a permission set (deny wins within a step). */
export function applyOverwrite(
  permissions: ReadonlySet<Permission>,
  overwrite: EngineOverwrite,
): Set<Permission> {
  const next = new Set(permissions);
  for (const denied of overwrite.deny) {
    if (isPermission(denied)) next.delete(denied);
  }
  for (const allowed of overwrite.allow) {
    if (isPermission(allowed)) next.add(allowed);
  }
  return next;
}

/** Community-scope effective permissions (`effective_permissions` in the API). */
export function resolveCommunityPermissions(
  subject: EngineSubject,
  roles: readonly EngineRole[],
): Set<Permission> {
  const base = basePermissions(subject, roles);
  return base === ALL ? new Set(ALL_PERMISSIONS) : base;
}

/** Channel-scope effective permissions for one channel. */
export function resolveChannelPermissions(
  subject: EngineSubject,
  roles: readonly EngineRole[],
  overwrites: readonly EngineOverwrite[],
): Set<Permission> {
  const base = basePermissions(subject, roles);
  // Owner / ADMINISTRATOR bypass channel overwrites entirely.
  if (base === ALL) return new Set(ALL_PERMISSIONS);

  let permissions: Set<Permission> = base;

  const everyoneRole = roles.find((role) => role.isEveryone);
  if (everyoneRole) {
    const everyoneOverwrite = overwrites.find(
      (overwrite) => overwrite.targetType === 'role' && overwrite.targetId === everyoneRole.id,
    );
    if (everyoneOverwrite) permissions = applyOverwrite(permissions, everyoneOverwrite);
  }

  for (const role of roles) {
    if (role.isEveryone || !subject.roleIds.includes(role.id)) continue;
    const overwrite = overwrites.find(
      (candidate) => candidate.targetType === 'role' && candidate.targetId === role.id,
    );
    if (overwrite) permissions = applyOverwrite(permissions, overwrite);
  }

  const memberOverwrite = overwrites.find(
    (overwrite) => overwrite.targetType === 'member' && overwrite.targetId === subject.userId,
  );
  if (memberOverwrite) permissions = applyOverwrite(permissions, memberOverwrite);

  return permissions;
}

export function hasPermission(
  permissions: ReadonlySet<Permission>,
  permission: Permission,
): boolean {
  return permissions.has(permission);
}

/** Total ordering helper: the highest position among the subject's roles. */
export function highestRolePosition(
  subject: EngineSubject,
  roles: readonly EngineRole[],
): number {
  let highest = -1;
  for (const role of roles) {
    if (!subject.roleIds.includes(role.id)) continue;
    if (role.position > highest) highest = role.position;
  }
  return highest;
}

export interface ChannelAccessFlags {
  can_view: boolean;
  can_read_history: boolean;
  can_send: boolean;
  can_connect: boolean;
  can_speak: boolean;
  can_video: boolean;
}

/**
 * Maps resolved channel permissions to the peer-service access flags.
 *
 * A timeout (`timed_out_until > now`) blocks sending, speaking and video, but
 * not viewing history or connecting to voice.
 */
export function channelAccessFlags(
  permissions: ReadonlySet<Permission>,
  state: { isMember: boolean; banned: boolean; timedOut: boolean },
): ChannelAccessFlags {
  if (!state.isMember || state.banned) {
    return {
      can_view: false,
      can_read_history: false,
      can_send: false,
      can_connect: false,
      can_speak: false,
      can_video: false,
    };
  }
  const canView = permissions.has('VIEW_CHANNEL');
  const canConnect = canView && permissions.has('CONNECT');
  const notTimedOut = !state.timedOut;
  return {
    can_view: canView,
    can_read_history: canView && permissions.has('READ_MESSAGE_HISTORY'),
    can_send: canView && permissions.has('SEND_MESSAGES') && notTimedOut,
    can_connect: canConnect,
    can_speak: canConnect && permissions.has('SPEAK') && notTimedOut,
    can_video: canConnect && permissions.has('VIDEO') && notTimedOut,
  };
}

/** Serializes a permission set in canonical spec order for the API. */
export function sortPermissions(permissions: ReadonlySet<Permission>): Permission[] {
  return normalizePermissions([...permissions]);
}
