import { uuidv4 } from '../ids.ts';
import { AppError } from '../errors.ts';
import type { AuthenticatedUser } from '../models/domain.ts';
import type { BanDto, BanListDto, MembershipDto } from '../models/dtos.ts';
import { toBan, toMembership } from '../models/responses.ts';
import { writeAuditEntry } from './audit.ts';
import { loadActorState, loadTargetCapability, requireMember } from './authorization.ts';
import type { ServiceDeps } from './context.ts';
import { assertPermission, assertTargetOutranked } from './guards.ts';
import { communityEvents } from '../events/event-schemas.ts';
import { enqueueEvent } from '../events/outbox.ts';

/** Hard cap on timeouts: 28 days (docs/openapi_spec.yaml#TimeoutRequest). */
export const MAX_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;
export const MIN_TIMEOUT_SECONDS = 60;

/**
 * Moderation: timeout/clear/kick/ban/list/unban.
 *
 * Every action is hierarchy-guarded (never the owner, never an equal-or-higher
 * member), audited and event-emitting in a single transaction.
 */
export class ModerationService {
  constructor(private readonly deps: ServiceDeps) {}

  async timeout(input: {
    actor: AuthenticatedUser;
    communityId: string;
    userId: string;
    durationSeconds: number;
    reason: string;
    memberMessage?: string | null | undefined;
    traceParent: string | null;
  }): Promise<MembershipDto> {
    const { withTransaction, clock, metrics } = this.deps;
    if (
      !Number.isInteger(input.durationSeconds) ||
      input.durationSeconds < MIN_TIMEOUT_SECONDS ||
      input.durationSeconds > MAX_TIMEOUT_SECONDS
    ) {
      throw AppError.unprocessable(
        `Timeout duration must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds`,
        { max_seconds: MAX_TIMEOUT_SECONDS },
      );
    }

    const state = await this.authorize(input.communityId, input.actor, 'TIMEOUT_MEMBERS');
    await this.requireTarget(state.community.ownerUserId === input.userId, input.communityId, input.userId);

    const { target } = await loadTargetCapability({
      repos: this.deps.repos,
      community: state.community,
      userId: input.userId,
    });
    assertTargetOutranked(state.actor, target);

    const now = clock.now();
    const timedOutUntil = new Date(now.getTime() + input.durationSeconds * 1000);
    const voiceChannelIds = await this.voiceChannelIds(input.communityId);

    const membership = await withTransaction(async (tx) => {
      const updated = await tx.membership.setTimedOutUntil(input.communityId, input.userId, timedOutUntil);
      if (!updated) throw AppError.notFound('Member not found');
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'member_timed_out',
        target: input.userId,
        reason: input.reason,
        changes: { timed_out_until: timedOutUntil.toISOString(), member_message: input.memberMessage ?? null },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.memberTimedOut({
          communityId: input.communityId,
          userId: input.userId,
          moderatorUserId: input.actor.userId,
          timedOutUntil,
          memberMessage: input.memberMessage ?? null,
          voiceChannelIds,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      return updated;
    });

    metrics.moderationActions.inc({ action: 'timeout' });
    const assignments = await this.deps.repos.memberRole.listForMember(input.communityId, input.userId);
    return toMembership(membership, assignments.map((assignment) => assignment.roleId));
  }

  /** Clearing an already-cleared timeout is idempotent and emits nothing. */
  async clearTimeout(input: {
    actor: AuthenticatedUser;
    communityId: string;
    userId: string;
    reason?: string | undefined;
    traceParent: string | null;
  }): Promise<void> {
    const { withTransaction, clock, metrics } = this.deps;
    const state = await this.authorize(input.communityId, input.actor, 'TIMEOUT_MEMBERS');
    const membership = await this.deps.repos.membership.find(input.communityId, input.userId);
    if (!membership) throw AppError.notFound('Member not found');

    const { target } = await loadTargetCapability({
      repos: this.deps.repos,
      community: state.community,
      userId: input.userId,
    });
    assertTargetOutranked(state.actor, target);

    if (membership.timedOutUntil === null) {
      metrics.moderationActions.inc({ action: 'timeout_clear' });
      return;
    }

    const now = clock.now();
    if (membership.timedOutUntil.getTime() <= now.getTime()) {
      metrics.moderationActions.inc({ action: 'timeout_clear' });
      return;
    }

    const voiceChannelIds = await this.voiceChannelIds(input.communityId);
    await withTransaction(async (tx) => {
      await tx.membership.setTimedOutUntil(input.communityId, input.userId, null);
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'member_timeout_cleared',
        target: input.userId,
        reason: input.reason ?? null,
        changes: { before: { timed_out_until: membership.timedOutUntil?.toISOString() ?? null } },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.memberTimeoutCleared({
          communityId: input.communityId,
          userId: input.userId,
          voiceChannelIds,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
    });

    metrics.moderationActions.inc({ action: 'timeout_clear' });
  }

  async kick(input: {
    actor: AuthenticatedUser;
    communityId: string;
    userId: string;
    reason: string;
    memberMessage?: string | null | undefined;
    traceParent: string | null;
  }): Promise<void> {
    const { withTransaction, clock, metrics } = this.deps;
    const state = await this.authorize(input.communityId, input.actor, 'KICK_MEMBERS');
    await this.requireTarget(state.community.ownerUserId === input.userId, input.communityId, input.userId);

    const { target } = await loadTargetCapability({
      repos: this.deps.repos,
      community: state.community,
      userId: input.userId,
    });
    assertTargetOutranked(state.actor, target);

    const now = clock.now();
    const voiceChannelIds = await this.voiceChannelIds(input.communityId);

    await withTransaction(async (tx) => {
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'member_kicked',
        target: input.userId,
        reason: input.reason,
        changes: { member_message: input.memberMessage ?? null },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.memberKicked({
          communityId: input.communityId,
          userId: input.userId,
          moderatorUserId: input.actor.userId,
          memberMessage: input.memberMessage ?? null,
          voiceChannelIds,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      await tx.memberRole.deleteForMember(input.communityId, input.userId);
      await tx.membership.delete(input.communityId, input.userId);
    });

    metrics.moderationActions.inc({ action: 'kick' });
  }

  async ban(input: {
    actor: AuthenticatedUser;
    communityId: string;
    userId: string;
    reason: string;
    memberMessage?: string | null | undefined;
    expiresAt?: Date | null | undefined;
    traceParent: string | null;
  }): Promise<BanDto> {
    const { withTransaction, clock, metrics } = this.deps;
    const state = await this.authorize(input.communityId, input.actor, 'BAN_MEMBERS');
    if (state.community.ownerUserId === input.userId) throw AppError.ownerProtected();

    const { target, membership } = await loadTargetCapability({
      repos: this.deps.repos,
      community: state.community,
      userId: input.userId,
    });
    assertTargetOutranked(state.actor, target);

    const now = clock.now();
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt && expiresAt.getTime() <= now.getTime()) {
      throw AppError.unprocessable('Ban expiry must be in the future');
    }
    const voiceChannelIds = await this.voiceChannelIds(input.communityId);

    const ban = await withTransaction(async (tx) => {
      const stored = await tx.ban.upsert({
        id: uuidv4(),
        communityId: input.communityId,
        userId: input.userId,
        reason: input.reason,
        memberMessage: input.memberMessage ?? null,
        expiresAt,
        createdBy: input.actor.userId,
        createdAt: now,
      });
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'member_banned',
        target: input.userId,
        reason: input.reason,
        changes: {
          member_message: input.memberMessage ?? null,
          expires_at: expiresAt ? expiresAt.toISOString() : null,
        },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.memberBanned({
          communityId: input.communityId,
          userId: input.userId,
          moderatorUserId: input.actor.userId,
          memberMessage: input.memberMessage ?? null,
          voiceChannelIds,
          banExpiresAt: expiresAt,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      if (membership) {
        await tx.memberRole.deleteForMember(input.communityId, input.userId);
        await tx.membership.delete(input.communityId, input.userId);
      }
      return stored;
    });

    metrics.moderationActions.inc({ action: 'ban' });
    return toBan(ban);
  }

  async listBans(input: {
    actor: AuthenticatedUser;
    communityId: string;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<BanListDto> {
    await this.authorize(input.communityId, input.actor, 'BAN_MEMBERS');
    const page = await this.deps.repos.ban.listByCommunity(input.communityId, {
      cursor: input.cursor,
      limit: input.limit,
    });
    return { bans: page.items.map(toBan), next_cursor: page.nextCursor };
  }

  async unban(input: {
    actor: AuthenticatedUser;
    communityId: string;
    userId: string;
    reason?: string | undefined;
    traceParent: string | null;
  }): Promise<void> {
    const { withTransaction, clock, metrics } = this.deps;
    await this.authorize(input.communityId, input.actor, 'BAN_MEMBERS');

    const existing = await this.deps.repos.ban.find(input.communityId, input.userId);
    if (!existing) throw AppError.notFound('Ban not found');

    const now = clock.now();
    await withTransaction(async (tx) => {
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'member_unbanned',
        target: input.userId,
        reason: input.reason ?? null,
        changes: {
          before: {
            reason: existing.reason,
            expires_at: existing.expiresAt ? existing.expiresAt.toISOString() : null,
          },
        },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.memberUnbanned({
          communityId: input.communityId,
          userId: input.userId,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      await tx.ban.delete(input.communityId, input.userId);
    });

    metrics.moderationActions.inc({ action: 'unban' });
  }

  private async authorize(
    communityId: string,
    actor: AuthenticatedUser,
    permission: 'TIMEOUT_MEMBERS' | 'KICK_MEMBERS' | 'BAN_MEMBERS',
  ) {
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId,
      userId: actor.userId,
    });
    requireMember(state);
    assertPermission(state.actor, permission);
    return state;
  }

  /** Moderation targets must currently be members (owners are rejected earlier). */
  private async requireTarget(isOwner: boolean, communityId: string, userId: string): Promise<void> {
    if (isOwner) throw AppError.ownerProtected();
    const membership = await this.deps.repos.membership.find(communityId, userId);
    if (!membership) throw AppError.notFound('Member not found');
  }

  private async voiceChannelIds(communityId: string): Promise<string[]> {
    const channels = await this.deps.repos.channel.listByCommunity(communityId);
    return channels.filter((channel) => channel.type === 'voice').map((channel) => channel.id);
  }
}
