import { uuidv4 } from '../ids.ts';
import { AppError } from '../errors.ts';
import type { AuthenticatedUser, ChannelRow, ChannelType } from '../models/domain.ts';
import type { ChannelDto } from '../models/responses.ts';
import { toChannel } from '../models/responses.ts';
import { writeAuditEntry } from './audit.ts';
import { loadActorState, requireMember } from './authorization.ts';
import type { ServiceDeps } from './context.ts';
import { assertPermission } from './guards.ts';
import { communityEvents } from '../events/event-schemas.ts';
import { enqueueEvent } from '../events/outbox.ts';

/** Channels: create/update/delete gated on `MANAGE_CHANNELS`. */
export class ChannelService {
  constructor(private readonly deps: ServiceDeps) {}

  async create(input: {
    actor: AuthenticatedUser;
    communityId: string;
    name: string;
    type: ChannelType;
    position?: number | undefined;
    traceParent: string | null;
  }): Promise<ChannelDto> {
    const { withTransaction, clock } = this.deps;
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    assertPermission(state.actor, 'MANAGE_CHANNELS');

    const now = clock.now();
    const position = input.position ?? (await this.nextPosition(input.communityId));

    const channel = await withTransaction(async (tx) => {
      const created = await tx.channel.insert({
        id: uuidv4(),
        communityId: input.communityId,
        name: input.name,
        type: input.type,
        position,
        createdAt: now,
        updatedAt: now,
      });
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'channel_created',
        target: created.id,
        changes: { after: { name: created.name, type: created.type, position: created.position } },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.channelCreated({
          communityId: input.communityId,
          channelId: created.id,
          name: created.name,
          type: created.type,
          position: created.position,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      return created;
    });

    return toChannel(channel);
  }

  async update(input: {
    actor: AuthenticatedUser;
    communityId: string;
    channelId: string;
    name?: string | undefined;
    position?: number | undefined;
    traceParent: string | null;
  }): Promise<ChannelDto> {
    const { withTransaction, clock } = this.deps;
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    assertPermission(state.actor, 'MANAGE_CHANNELS');

    const existing = await this.loadChannel(input.communityId, input.channelId);
    const now = clock.now();

    const updated = await withTransaction(async (tx) => {
      const channel = await tx.channel.update(input.channelId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        updatedAt: now,
      });
      if (!channel) throw AppError.notFound('Channel not found');
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'channel_updated',
        target: channel.id,
        changes: {
          before: { name: existing.name, position: existing.position },
          after: { name: channel.name, position: channel.position },
        },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.channelUpdated({
          communityId: input.communityId,
          channelId: channel.id,
          name: channel.name,
          type: channel.type,
          position: channel.position,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      return channel;
    });

    return toChannel(updated);
  }

  async remove(input: {
    actor: AuthenticatedUser;
    communityId: string;
    channelId: string;
    traceParent: string | null;
  }): Promise<void> {
    const { withTransaction, clock } = this.deps;
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    assertPermission(state.actor, 'MANAGE_CHANNELS');

    const channel = await this.loadChannel(input.communityId, input.channelId);
    const now = clock.now();

    await withTransaction(async (tx) => {
      await writeAuditEntry(tx, {
        communityId: input.communityId,
        actorUserId: input.actor.userId,
        action: 'channel_deleted',
        target: channel.id,
        changes: { before: { name: channel.name, type: channel.type } },
        occurredAt: now,
      });
      await enqueueEvent(
        tx,
        communityEvents.channelDeleted({
          communityId: input.communityId,
          channelId: channel.id,
          type: channel.type,
          traceParent: input.traceParent,
        }),
        { occurredAt: now },
      );
      await tx.channel.deleteById(channel.id);
    });
  }

  private async loadChannel(communityId: string, channelId: string): Promise<ChannelRow> {
    const channel = await this.deps.repos.channel.findById(channelId);
    if (!channel || channel.communityId !== communityId) throw AppError.notFound('Channel not found');
    return channel;
  }

  private async nextPosition(communityId: string): Promise<number> {
    const channels = await this.deps.repos.channel.listByCommunity(communityId);
    const highest = channels.reduce((max, channel) => Math.max(max, channel.position), -1);
    return highest + 1;
  }
}
