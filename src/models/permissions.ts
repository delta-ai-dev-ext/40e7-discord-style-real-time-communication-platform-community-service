/**
 * The fixed permission vocabulary (docs/openapi_spec.yaml#Permission).
 * Values are stored in `role.permissions` / `permission_overwrite.{allow,deny}`.
 */
export const PERMISSIONS = [
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'READ_MESSAGE_HISTORY',
  'CONNECT',
  'SPEAK',
  'VIDEO',
  'CREATE_INVITE',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'TIMEOUT_MEMBERS',
  'KICK_MEMBERS',
  'BAN_MEMBERS',
  'VIEW_AUDIT_LOG',
  'ADMINISTRATOR',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ADMINISTRATOR: Permission = 'ADMINISTRATOR';

/** Every permission, in the canonical order of the spec. */
export const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS;

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** Drops unknown values and deduplicates, preserving canonical order. */
export function normalizePermissions(values: readonly string[]): Permission[] {
  const seen = new Set<Permission>();
  for (const value of values) {
    if (isPermission(value)) seen.add(value);
  }
  return PERMISSIONS.filter((permission) => seen.has(permission));
}

export function toPermissionSet(values: readonly string[]): Set<Permission> {
  return new Set(normalizePermissions(values));
}

export function hasPermission(permissions: ReadonlySet<Permission>, permission: Permission): boolean {
  return permissions.has(permission);
}

/** Diff helper used to build audit `changes` payloads. */
export function permissionDiff(
  before: readonly string[],
  after: readonly string[],
): { added: Permission[]; removed: Permission[] } {
  const beforeSet = toPermissionSet(before);
  const afterSet = toPermissionSet(after);
  return {
    added: normalizePermissions(after).filter((permission) => !beforeSet.has(permission)),
    removed: normalizePermissions(before).filter((permission) => !afterSet.has(permission)),
  };
}
