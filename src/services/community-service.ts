import { uuidv4 } from '../ids.ts';
import { AppError } from '../errors.ts';
import type { AuthenticatedUser, ChannelRow, CommunityRow } from '../models/domain.ts';
import { ALL_PERMISSIONS, type Permission } from '../models/permissions.ts';
import type { CommunityDetailDto } from '../models/responses.ts';
import { toCommunityDetail } from '../models/responses.ts';
import type { Repositories } from '../repositories/types.ts';
import { writeAuditEntry } from './audit.ts';
import { loadActorState, requireMember } from './authorization.ts';
import type { ServiceDeps } from './context.ts';
import { communityEvents } from '../events/event-schemas.ts';
import { enqueueEvent } from '../events/outbox.ts';
import { resolveChannelPermissions, resolveCommunityPermissions, sortPermissions } from './permission-engine.ts';

/**
 * Communities: creation with defaults, sidebar listing, detail view, rename and
 * delete (all owner-gated where the spec demands it).
 */
export class CommunityService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Creates the community, its implicit `@everyone` role, the default `#general`
   * text channel, the `General` voice channel and the owner's membership.
   */
  async create(input: {
    actor: AuthenticatedUser;
    name: string;
    traceParent: string | null;
  }): Promise<CommunityDetailDto> {
    const { withTransaction, clock, metrics, logger } = this.deps;
    const now = clock.now();
    const communityId = uuidv4();

    const created = await withTransaction(async (tx) => {
      const community = await tx.community.insert({
        id: communityId,
        name: input.name,
        ownerUserId: input.actor.userId,
        createdAt: now,
        updatedAt: now,
      });
      await tx.role.insert({
        id: uuidv4(),
        communityId,
        name: '@everyone',
        permissions: [],
        position: 0,
        isEveryone: true,
        createdAt: now,
        updatedAt: now,
      });
      const channels: ChannelRow[] = [
        await tx.channel.insert({
          id: uuidv4(),
          communityId,
          name: 'general',
          type: 'text',
          position: 0,
          createdAt: now,
          updatedAt: now,
        }),
        await tx.channel.insert({
          id: uuidv4(),
          communityId,
          name: 'General',
          type: 'voice',
          position: 1,
          createdAt: now,
          updatedAt: now,
        }),
      ];
      await tx.membership.insert({
        id: uuidv4(),
        communityId,
        userId: input.actor.userId,
        nickname: null,
        timedOutUntil: null,
        joinedAt: now,
      });
      return { community, channels };
    });

    metrics.communityCreated.inc();
    logger.info('community.created', {
      community_id: created.community.id,
      operation: 'create_community',
      trace_parent: input.traceParent,
    });

    return toCommunityDetail(created.community, created.channels, [...ALL_PERMISSIONS], 1);
  }

  /** Communities the caller belongs to, each with their visible channels. */
  async listMine(actor: AuthenticatedUser): Promise<CommunityDetailDto[]> {
    const { repos } = this.deps;
    const communities = await repos.community.listByMember(actor.userId);
    const details: CommunityDetailDto[] = [];
    for (const community of communities) {
      details.push(await this.buildDetail(repos, community, actor.userId));
    }
    return details;
  }

  /** Community detail with the caller's visible channels and permissions. */
  async get(input: { actor: AuthenticatedUser; communityId: string }): Promise<CommunityDetailDto> {
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    return this.buildDetail(this.deps.repos, state.community, input.actor.userId);
  }

  /** Rename (owner only): audit entry + `community_updated` event, one transaction. */
  async rename(input: {
    actor: AuthenticatedUser;
    communityId: string;
    name: string;
    traceParent: string | null;
  }): Promise<CommunityRow> {
    const { withTransaction, clock } = this.deps;
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    if (!state.isOwner) throw AppError.ownerOnly();

    const now = clock.now();
    return withTransaction(async (tx) => {
      const updated = await tx.community.updateName(input.communityId, input.name, now);
      if (!updated) throw AppError.notFound('Community not found');
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'community_renamed',
        target: input.communityId,
        changes: { before: { name: state.community.name }, after: { name: updated.name } },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.communityUpdated({
          communityId: input.communityId,
          name: updated.name,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      return updated;
    });
  }

  /**
   * Delete (owner only). Emits `community_deleted` carrying the channel ids so
   * peer services can purge dependent data.
   */
  async remove(input: {
    actor: AuthenticatedUser;
    communityId: string;
    traceParent: string | null;
  }): Promise<void> {
    const { withTransaction, clock, logger } = this.deps;
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    if (!state.isOwner) throw AppError.ownerOnly();

    const now = clock.now();
    await withTransaction(async (tx) => {
      const channelIds = await tx.channel.listIdsByCommunity(input.communityId);
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'community_deleted',
        target: input.communityId,
        changes: { channel_ids: channelIds },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.communityDeleted({
          communityId: input.communityId,
          channelIds,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      await tx.community.deleteById(input.communityId);
    });

    logger.info('community.deleted', {
      community_id: input.communityId,
      operation: 'delete_community',
      trace_parent: input.traceParent,
    });
  }

  /**
   * Builds a `CommunityDetail` for one caller: visible channels only, plus the
   * caller's resolved community-scope permissions.
   */
  private async buildDetail(
    repos: Repositories,
    community: CommunityRow,
    userId: string,
  ): Promise<CommunityDetailDto> {
    const [roles, channels, membership, memberCount] = await Promise.all([
      repos.role.listByCommunity(community.id),
      repos.channel.listByCommunity(community.id),
      repos.membership.find(community.id, userId),
      repos.membership.countByCommunity(community.id),
    ]);
    const assignments = membership ? await repos.memberRole.listForMember(community.id, userId) : [];
    const roleIds = assignments.map((assignment) => assignment.roleId);
    const isOwner = community.ownerUserId === userId;
    const subject = { userId, isOwner, roleIds, isMember: membership !== null || isOwner };

    const visible: ChannelRow[] = [];
    for (const channel of channels) {
      const overwrites = await repos.overwrite.listByChannel(channel.id);
      const permissions = resolveChannelPermissions(subject, roles, overwrites);
      if (permissions.has('VIEW_CHANNEL')) visible.push(channel);
    }

    const communityPermissions: Permission[] = sortPermissions(
      resolveCommunityPermissions(subject, roles),
    );

    return toCommunityDetail(community, visible, communityPermissions, memberCount);
  }
}
