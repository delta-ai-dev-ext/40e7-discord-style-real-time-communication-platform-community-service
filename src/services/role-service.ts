import { uuidv4 } from '../ids.ts';
import { AppError } from '../errors.ts';
import type { AuthenticatedUser, RoleRow } from '../models/domain.ts';
import { normalizePermissions, permissionDiff } from '../models/permissions.ts';
import type { RoleDto } from '../models/responses.ts';
import { toRole } from '../models/responses.ts';
import { writeAuditEntry } from './audit.ts';
import { loadActorState, requireMember } from './authorization.ts';
import type { ServiceDeps } from './context.ts';
import {
  assertCanGrantPermissions,
  assertCanManageRolePosition,
  assertPermission,
} from './guards.ts';
import { communityEvents } from '../events/event-schemas.ts';
import { enqueueEvent } from '../events/outbox.ts';

/**
 * Roles: CRUD gated on `MANAGE_ROLES`, protected by hierarchy guards
 * (no acting on a role at/above your own position) and the self-grant rule.
 */
export class RoleService {
  constructor(private readonly deps: ServiceDeps) {}

  async list(input: { actor: AuthenticatedUser; communityId: string }): Promise<RoleDto[]> {
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    return state.roles.map(toRole);
  }

  async create(input: {
    actor: AuthenticatedUser;
    communityId: string;
    name: string;
    permissions: readonly string[];
    position: number;
    traceParent: string | null;
  }): Promise<RoleDto> {
    const { withTransaction, clock } = this.deps;
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    assertPermission(state.actor, 'MANAGE_ROLES');
    assertCanManageRolePosition(state.actor, input.position);
    const permissions = normalizePermissions(input.permissions);
    assertCanGrantPermissions(state.actor, permissions, { role_position: input.position });

    const now = clock.now();
    const role = await withTransaction(async (tx) => {
      const created = await tx.role.insert({
        id: uuidv4(),
        communityId: input.communityId,
        name: input.name,
        permissions,
        position: input.position,
        isEveryone: false,
        createdAt: now,
        updatedAt: now,
      });
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'role_created',
        target: created.id,
        changes: { after: { name: created.name, permissions, position: created.position } },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.rolesChanged({
          communityId: input.communityId,
          roleId: created.id,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      return created;
    });

    return toRole(role);
  }

  async update(input: {
    actor: AuthenticatedUser;
    communityId: string;
    roleId: string;
    name?: string | undefined;
    permissions?: readonly string[] | undefined;
    position?: number | undefined;
    traceParent: string | null;
  }): Promise<RoleDto> {
    const { withTransaction, clock } = this.deps;
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    assertPermission(state.actor, 'MANAGE_ROLES');

    const existing = await this.loadRole(input.communityId, input.roleId);
    if (existing.isEveryone) throw AppError.protectedRole();
    assertCanManageRolePosition(state.actor, existing.position);
    if (input.position !== undefined) assertCanManageRolePosition(state.actor, input.position);
    const permissions =
      input.permissions !== undefined ? normalizePermissions(input.permissions) : undefined;
    if (permissions) assertCanGrantPermissions(state.actor, permissions, { role_position: existing.position });

    const now = clock.now();
    const role = await withTransaction(async (tx) => {
      const updated = await tx.role.update(input.roleId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(permissions !== undefined ? { permissions } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        updatedAt: now,
      });
      if (!updated) throw AppError.notFound('Role not found');

      const diff = permissionDiff(existing.permissions, updated.permissions);
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'role_updated',
        target: updated.id,
        changes: {
          before: { name: existing.name, permissions: existing.permissions, position: existing.position },
          after: { name: updated.name, permissions: updated.permissions, position: updated.position },
          permissions_added: diff.added,
          permissions_removed: diff.removed,
        },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.rolesChanged({
          communityId: input.communityId,
          roleId: updated.id,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      return updated;
    });

    return toRole(role);
  }

  async remove(input: {
    actor: AuthenticatedUser;
    communityId: string;
    roleId: string;
    traceParent: string | null;
  }): Promise<void> {
    const { withTransaction, clock } = this.deps;
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    assertPermission(state.actor, 'MANAGE_ROLES');

    const existing = await this.loadRole(input.communityId, input.roleId);
    if (existing.isEveryone) throw AppError.protectedRole();
    assertCanManageRolePosition(state.actor, existing.position);

    const now = clock.now();
    await withTransaction(async (tx) => {
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'role_deleted',
        target: existing.id,
        changes: { before: { name: existing.name, permissions: existing.permissions, position: existing.position } },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.rolesChanged({
          communityId: input.communityId,
          roleId: existing.id,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      await tx.role.deleteById(existing.id);
    });
  }

  private async loadRole(communityId: string, roleId: string): Promise<RoleRow> {
    const role = await this.deps.repos.role.findById(roleId);
    if (!role || role.communityId !== communityId) throw AppError.notFound('Role not found');
    return role;
  }
}
