import { AppError } from '../errors.ts';
import type {
  ChannelAccessDto,
  MemberAccessDto,
} from '../models/dtos.ts';
import type { Repositories } from '../repositories/types.ts';
import type { ServiceDeps } from './context.ts';
import {
  channelAccessFlags,
  resolveChannelPermissions,
  type EngineOverwrite,
  type EngineSubject,
} from './permission-engine.ts';

/**
 * Internal access decisions consumed synchronously by chat, voice and the
 * realtime gateway (docs/architecture.md §3.4). These are read-only hot paths:
 * no transaction, no audit, no outbox.
 */
export class AccessService {
  constructor(private readonly deps: ServiceDeps) {}

  async channelAccess(input: { channelId: string; userId: string }): Promise<ChannelAccessDto> {
    const { repos, clock } = this.deps;
    const now = clock.now();

    const channel = await repos.channel.findById(input.channelId);
    if (!channel) throw AppError.notFound('Channel not found');
    const community = await repos.community.findById(channel.communityId);
    if (!community) throw AppError.notFound('Community not found');

    const subject = await this.loadSubject(repos, channel.communityId, input.userId, community.ownerUserId);
    const activeBan = await repos.ban.findActive(channel.communityId, input.userId, now);
    const roles = await repos.role.listByCommunity(channel.communityId);
    const overwrites = await repos.overwrite.listByChannel(channel.id);
    const timedOut = isTimedOut(subject, now);

    const permissions =
      activeBan || !subject.isMember
        ? new Set<never>()
        : resolveChannelPermissions(subject, roles, overwrites);

    const flags = channelAccessFlags(permissions, {
      isMember: subject.isMember,
      banned: activeBan !== null,
      timedOut,
    });

    return {
      community_id: channel.communityId,
      channel_type: channel.type,
      is_member: subject.isMember,
      ...flags,
      timed_out_until: timedOut ? subject.timedOutUntil!.toISOString() : null,
      banned: activeBan !== null,
    };
  }

  async memberAccess(input: { communityId: string; userId: string }): Promise<MemberAccessDto> {
    const { repos, clock } = this.deps;
    const now = clock.now();

    const community = await repos.community.findById(input.communityId);
    if (!community) throw AppError.notFound('Community not found');

    const subject = await this.loadSubject(repos, input.communityId, input.userId, community.ownerUserId);
    const activeBan = await repos.ban.findActive(input.communityId, input.userId, now);
    const [roles, channels, overwrites] = await Promise.all([
      repos.role.listByCommunity(input.communityId),
      repos.channel.listByCommunity(input.communityId),
      repos.overwrite.listByCommunity(input.communityId),
    ]);

    const byChannel = new Map<string, EngineOverwrite[]>();
    for (const overwrite of overwrites) {
      const list = byChannel.get(overwrite.channelId) ?? [];
      list.push(overwrite);
      byChannel.set(overwrite.channelId, list);
    }

    const visible: string[] = [];
    if (!activeBan && subject.isMember) {
      for (const channel of channels) {
        const permissions = resolveChannelPermissions(subject, roles, byChannel.get(channel.id) ?? []);
        if (permissions.has('VIEW_CHANNEL')) visible.push(channel.id);
      }
    }

    const timedOut = isTimedOut(subject, now);
    return {
      is_member: subject.isMember,
      banned: activeBan !== null,
      visible_channel_ids: visible,
      timed_out_until: timedOut ? subject.timedOutUntil!.toISOString() : null,
    };
  }

  private async loadSubject(
    repos: Repositories,
    communityId: string,
    userId: string,
    ownerUserId: string,
  ): Promise<EngineSubject & { timedOutUntil: Date | null }> {
    const membership = await repos.membership.find(communityId, userId);
    const assignments = membership ? await repos.memberRole.listForMember(communityId, userId) : [];
    const isOwner = ownerUserId === userId;
    return {
      userId,
      isOwner,
      roleIds: assignments.map((assignment) => assignment.roleId),
      isMember: membership !== null || isOwner,
      timedOutUntil: membership?.timedOutUntil ?? null,
    };
  }
}

function isTimedOut(
  subject: { timedOutUntil: Date | null },
  now: Date,
): boolean {
  return subject.timedOutUntil !== null && subject.timedOutUntil.getTime() > now.getTime();
}
