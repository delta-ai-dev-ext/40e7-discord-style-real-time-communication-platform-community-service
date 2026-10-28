import { AppError } from '../errors.ts';
import type { AuthenticatedUser } from '../models/domain.ts';
import type { MemberListDto, MembershipDto } from '../models/dtos.ts';
import { toMember, toMembership } from '../models/responses.ts';
import { writeAuditEntry } from './audit.ts';
import { loadActorState, loadTargetCapability, requireMember } from './authorization.ts';
import type { ServiceDeps } from './context.ts';
import { assertPermission, assertRoleAssignable, assertTargetOutranked } from './guards.ts';
import { communityEvents } from '../events/event-schemas.ts';
import { enqueueEvent } from '../events/outbox.ts';

/**
 * Memberships: listing, self-service nickname, leaving, and role assignment
 * (role changes are hierarchy- and self-grant-guarded).
 */
export class MemberService {
  constructor(private readonly deps: ServiceDeps) {}

  async list(input: {
    actor: AuthenticatedUser;
    communityId: string;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<MemberListDto> {
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);

    const [page, assignments] = await Promise.all([
      this.deps.repos.membership.listByCommunity(input.communityId, {
        cursor: input.cursor,
        limit: input.limit,
      }),
      this.deps.repos.memberRole.listByCommunity(input.communityId),
    ]);

    const rolesByUser = new Map<string, string[]>();
    for (const assignment of assignments) {
      const list = rolesByUser.get(assignment.userId) ?? [];
      list.push(assignment.roleId);
      rolesByUser.set(assignment.userId, list);
    }

    return {
      members: page.items.map((membership) => toMember(membership, rolesByUser.get(membership.userId) ?? [])),
      next_cursor: page.nextCursor,
    };
  }

  /** Self-service nickname: only the caller's own membership record. */
  async updateNickname(input: {
    actor: AuthenticatedUser;
    communityId: string;
    nickname: string | null;
  }): Promise<MembershipDto> {
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);

    const updated =
      input.nickname === null
        ? await this.deps.repos.membership.updateNickname(input.communityId, input.actor.userId, null)
        : await this.deps.repos.membership.updateNickname(
            input.communityId,
            input.actor.userId,
            input.nickname,
          );
    if (!updated) throw AppError.notFound('Membership not found');

    const assignments = await this.deps.repos.memberRole.listForMember(
      input.communityId,
      input.actor.userId,
    );
    return toMembership(updated, assignments.map((assignment) => assignment.roleId));
  }

  /** Leaving removes the membership and its role assignments. */
  async leave(input: {
    actor: AuthenticatedUser;
    communityId: string;
    traceParent: string | null;
  }): Promise<void> {
    const { withTransaction, clock } = this.deps;
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    if (state.isOwner) throw AppError.ownerCannotLeave();

    const now = clock.now();
    await withTransaction(async (tx) => {
      await enqueueEvent(
        tx,
        communityEvents.memberLeft({
          communityId: input.communityId,
          userId: input.actor.userId,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      await tx.memberRole.deleteForMember(input.communityId, input.actor.userId);
      await tx.membership.delete(input.communityId, input.actor.userId);
    });
  }

  async assignRole(input: {
    actor: AuthenticatedUser;
    communityId: string;
    userId: string;
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

    const role = await this.deps.repos.role.findById(input.roleId);
    if (!role || role.communityId !== input.communityId) throw AppError.notFound('Role not found');

    const { target } = await loadTargetCapability({
      repos: this.deps.repos,
      community: state.community,
      userId: input.userId,
    });
    if (!target.isOwner && (await this.deps.repos.membership.find(input.communityId, input.userId)) === null) {
      throw AppError.notFound('Member not found');
    }
    assertTargetOutranked(state.actor, target);
    assertRoleAssignable({ actor: state.actor, role });

    const now = clock.now();
    await withTransaction(async (tx) => {
      await tx.memberRole.assign({
        communityId: input.communityId,
        userId: input.userId,
        roleId: role.id,
        assignedBy: input.actor.userId,
        assignedAt: now,
      });
      const assignments = await tx.memberRole.listForMember(input.communityId, input.userId);
      const roleIds = assignments.map((assignment) => assignment.roleId);
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'member_role_assigned',
        target: input.userId,
        changes: { role_id: role.id, after: { roles: roleIds } },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.memberRolesChanged({
          communityId: input.communityId,
          userId: input.userId,
          roleIds,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
    });
  }

  async removeRole(input: {
    actor: AuthenticatedUser;
    communityId: string;
    userId: string;
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

    const role = await this.deps.repos.role.findById(input.roleId);
    if (!role || role.communityId !== input.communityId) throw AppError.notFound('Role not found');
    if (role.isEveryone) throw AppError.protectedRole('The @everyone role cannot be removed from a member');

    const { target } = await loadTargetCapability({
      repos: this.deps.repos,
      community: state.community,
      userId: input.userId,
    });
    if (!target.isOwner && (await this.deps.repos.membership.find(input.communityId, input.userId)) === null) {
      throw AppError.notFound('Member not found');
    }
    assertTargetOutranked(state.actor, target);
    assertRoleAssignable({ actor: state.actor, role });

    const assigned = await this.deps.repos.memberRole.listForMember(input.communityId, input.userId);
    if (!assigned.some((assignment) => assignment.roleId === role.id)) {
      throw AppError.notFound('Role is not assigned to this member');
    }

    const now = clock.now();
    await withTransaction(async (tx) => {
      await tx.memberRole.remove(input.communityId, input.userId, role.id);
      const assignments = await tx.memberRole.listForMember(input.communityId, input.userId);
      const roleIds = assignments.map((assignment) => assignment.roleId);
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'member_role_removed',
        target: input.userId,
        changes: { role_id: role.id, after: { roles: roleIds } },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.memberRolesChanged({
          communityId: input.communityId,
          userId: input.userId,
          roleIds,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
    });
  }
}
