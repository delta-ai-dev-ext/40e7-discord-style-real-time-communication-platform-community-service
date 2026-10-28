import { uuidv4 } from '../ids.ts';
import { AppError } from '../errors.ts';
import type { AuthenticatedUser, ChannelRow, OverwriteTargetType } from '../models/domain.ts';
import { normalizePermissions, permissionDiff } from '../models/permissions.ts';
import type { PermissionOverwriteDto } from '../models/responses.ts';
import { toPermissionOverwrite } from '../models/responses.ts';
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
 * Per-channel permission overwrites (US-006).
 *
 * An actor needs `MANAGE_CHANNELS` (plus `MANAGE_ROLES` when targeting a role),
 * cannot touch roles at/above their own position, and cannot grant a permission
 * they do not hold themselves unless owner/ADMINISTRATOR.
 */
export class OverwriteService {
  constructor(private readonly deps: ServiceDeps) {}

  async upsert(input: {
    actor: AuthenticatedUser;
    communityId: string;
    channelId: string;
    targetType: OverwriteTargetType;
    targetId: string;
    allow: readonly string[];
    deny: readonly string[];
    traceParent: string | null;
  }): Promise<PermissionOverwriteDto> {
    const { withTransaction, clock } = this.deps;
    const state = await this.authorize(input);
    const channel = await this.loadChannel(input.communityId, input.channelId);

    const allow = normalizePermissions(input.allow);
    const deny = normalizePermissions(input.deny);
    const overlap = allow.filter((permission) => deny.includes(permission));
    if (overlap.length > 0) {
      throw AppError.unprocessable('A permission cannot be both allowed and denied', {
        permissions: overlap,
      });
    }
    assertCanGrantPermissions(state.actor, allow, { channel_id: channel.id });

    const now = clock.now();
    const existing = await this.deps.repos.overwrite.find(channel.id, input.targetType, input.targetId);

    const stored = await withTransaction(async (tx) => {
      const row = await tx.overwrite.upsert({
        id: existing?.id ?? uuidv4(),
        channelId: channel.id,
        targetType: input.targetType,
        targetId: input.targetId,
        allow,
        deny,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      const diff = permissionDiff(existing?.allow ?? [], allow);
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'permission_overwrite_set',
        target: channel.id,
        changes: {
          target_type: input.targetType,
          target_id: input.targetId,
          before: { allow: existing?.allow ?? [], deny: existing?.deny ?? [] },
          after: { allow, deny },
          permissions_added: diff.added,
          permissions_removed: diff.removed,
        },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.permissionOverwritesChanged({
          communityId: input.communityId,
          channelId: channel.id,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      return row;
    });

    return toPermissionOverwrite(stored);
  }

  async remove(input: {
    actor: AuthenticatedUser;
    communityId: string;
    channelId: string;
    targetType: OverwriteTargetType;
    targetId: string;
    traceParent: string | null;
  }): Promise<void> {
    const { withTransaction, clock } = this.deps;
    await this.authorize(input);
    const channel = await this.loadChannel(input.communityId, input.channelId);

    const existing = await this.deps.repos.overwrite.find(
      channel.id,
      input.targetType,
      input.targetId,
    );
    if (!existing) throw AppError.notFound('Permission overwrite not found');

    const now = clock.now();
    await withTransaction(async (tx) => {
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'permission_overwrite_removed',
        target: channel.id,
        changes: {
          target_type: input.targetType,
          target_id: input.targetId,
          before: { allow: existing.allow, deny: existing.deny },
        },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.permissionOverwritesChanged({
          communityId: input.communityId,
          channelId: channel.id,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      await tx.overwrite.delete(channel.id, input.targetType, input.targetId);
    });
  }

  private async authorize(input: {
    actor: AuthenticatedUser;
    communityId: string;
    targetType: OverwriteTargetType;
    targetId: string;
  }) {
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    assertPermission(state.actor, 'MANAGE_CHANNELS');

    if (input.targetType === 'role') {
      assertPermission(state.actor, 'MANAGE_ROLES');
      const role = await this.deps.repos.role.findById(input.targetId);
      if (!role || role.communityId !== input.communityId) throw AppError.notFound('Role not found');
      if (!role.isEveryone) {
        // Tuning a role you do not outrank would let an actor weaken or boost it.
        assertCanManageRolePosition(state.actor, role.position);
      }
    }
    return state;
  }

  private async loadChannel(communityId: string, channelId: string): Promise<ChannelRow> {
    const channel = await this.deps.repos.channel.findById(channelId);
    if (!channel || channel.communityId !== communityId) throw AppError.notFound('Channel not found');
    return channel;
  }
}
