import { AppError } from '../errors.ts';
import type { Permission } from '../models/permissions.ts';
import { isPermission } from '../models/permissions.ts';
import { hasPermission } from './permission-engine.ts';

/**
 * Hierarchy and self-grant guards (docs/architecture.md §3.2).
 *
 * Pure functions: they receive positions that callers resolved from the
 * database and throw typed domain errors, so the rules are tested in isolation
 * and reused by role, overwrite, member-role and moderation services.
 */
export interface ActorCapability {
  userId: string;
  isOwner: boolean;
  /** Highest position among the actor's roles; `Infinity` for the owner. */
  highestRolePosition: number;
  permissions: ReadonlySet<Permission>;
}

export interface TargetCapability {
  userId: string;
  isOwner: boolean;
  highestRolePosition: number;
}

/** Owner or `ADMINISTRATOR` bypasses permission and self-grant restrictions. */
export function isPrivileged(actor: ActorCapability): boolean {
  return actor.isOwner || hasPermission(actor.permissions, 'ADMINISTRATOR');
}

/** Highest role position for a member; `Infinity` for the community owner. */
export function resolveHighestRolePosition(options: {
  isOwner: boolean;
  roleIds: readonly string[];
  roles: readonly { id: string; position: number }[];
}): number {
  if (options.isOwner) return Number.POSITIVE_INFINITY;
  let highest = -1;
  for (const role of options.roles) {
    if (!options.roleIds.includes(role.id)) continue;
    if (role.position > highest) highest = role.position;
  }
  return highest;
}

export function assertPermission(actor: ActorCapability, permission: Permission): void {
  if (!hasPermission(actor.permissions, permission)) {
    throw AppError.missingPermission(permission);
  }
}

export function assertOwner(actor: ActorCapability): void {
  if (!actor.isOwner) throw AppError.ownerOnly();
}

/**
 * A role at or above the actor's own highest position cannot be created,
 * modified or deleted (hierarchy protection).
 */
export function assertCanManageRolePosition(actor: ActorCapability, position: number): void {
  if (actor.isOwner) return;
  if (position >= actor.highestRolePosition) {
    throw AppError.hierarchy(
      'You cannot manage a role at or above your own highest role position',
      { actor_highest_position: actor.highestRolePosition, role_position: position },
    );
  }
}

/** Owner is untouchable; equal-or-higher members are out of reach. */
export function assertTargetOutranked(actor: ActorCapability, target: TargetCapability): void {
  if (target.isOwner) throw AppError.ownerProtected();
  if (actor.isOwner) return;
  if (target.highestRolePosition >= actor.highestRolePosition) {
    throw AppError.hierarchy(
      'You cannot act on a member at or above your own highest role position',
      { actor_highest_position: actor.highestRolePosition, target_highest_position: target.highestRolePosition },
    );
  }
}

/**
 * A non-privileged actor can never grant a permission they do not hold
 * themselves (role permissions, role assignment and allow-overwrites).
 */
export function assertCanGrantPermissions(
  actor: ActorCapability,
  permissions: readonly string[],
  context?: Record<string, unknown>,
): void {
  if (isPrivileged(actor)) return;
  for (const permission of permissions) {
    if (!isPermission(permission)) continue;
    if (!hasPermission(actor.permissions, permission)) {
      throw AppError.cannotGrant(permission, context);
    }
  }
}

/** Role hierarchy guard applied to the role rows a member holds. */
export function assertRoleAssignable(options: {
  actor: ActorCapability;
  role: { position: number; isEveryone: boolean; permissions: readonly string[] };
}): void {
  if (options.role.isEveryone) {
    throw AppError.protectedRole('The @everyone role applies to every member and cannot be assigned');
  }
  assertCanManageRolePosition(options.actor, options.role.position);
  assertCanGrantPermissions(options.actor, options.role.permissions, {
    role_position: options.role.position,
  });
}
