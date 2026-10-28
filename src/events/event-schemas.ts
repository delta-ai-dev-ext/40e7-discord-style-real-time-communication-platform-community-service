import type { OutboxTopic } from '../models/domain.ts';

/**
 * Versioned event contracts (docs/architecture.md §4.2 / §4.3).
 *
 * Every state change that has a domain event stores one of these descriptors in
 * `outbox_event` inside the same transaction; the relay turns it into the wire
 * envelope below.
 */
export const COMMUNITY_EVENTS_TOPIC: OutboxTopic = 'community_events';
export const COMMUNITY_INVITE_EVENTS_TOPIC: OutboxTopic = 'community_invite_events';
export const PRODUCER_NAME = 'community_service';
export const EVENT_VERSION = 1;

export type CommunityEventType =
  | 'community_updated'
  | 'community_deleted'
  | 'channel_created'
  | 'channel_updated'
  | 'channel_deleted'
  | 'member_joined'
  | 'member_left'
  | 'member_roles_changed'
  | 'roles_changed'
  | 'permission_overwrites_changed'
  | 'member_timed_out'
  | 'member_timeout_cleared'
  | 'member_kicked'
  | 'member_banned'
  | 'member_unbanned';

export type InviteEventType = 'invite_email_requested';

export type EventType = CommunityEventType | InviteEventType;

/** Wire envelope shared by both topics. */
export interface EventEnvelope<T = Record<string, unknown>> {
  event_id: string;
  event_type: EventType;
  occurred_at: string;
  producer: typeof PRODUCER_NAME;
  version: number;
  trace_parent: string | null;
  data: T;
}

/** A not-yet-persisted event: partition key is always the `community_id`. */
export interface DomainEvent {
  topic: OutboxTopic;
  eventType: EventType;
  partitionKey: string;
  data: Record<string, unknown>;
  traceParent: string | null;
}

export function buildEnvelope(input: {
  eventId: string;
  eventType: EventType;
  occurredAt: Date;
  traceParent: string | null;
  data: Record<string, unknown>;
}): EventEnvelope {
  return {
    event_id: input.eventId,
    event_type: input.eventType,
    occurred_at: input.occurredAt.toISOString(),
    producer: PRODUCER_NAME,
    version: EVENT_VERSION,
    trace_parent: input.traceParent,
    data: input.data,
  };
}

interface Traceable {
  traceParent?: string | null;
}

function base(communityId: string, trace: Traceable | undefined): Pick<DomainEvent, 'topic' | 'partitionKey' | 'traceParent'> {
  return {
    topic: COMMUNITY_EVENTS_TOPIC,
    partitionKey: communityId,
    traceParent: trace?.traceParent ?? null,
  };
}

/** `community_events` factories — data shapes exactly as documented. */
export const communityEvents = {
  communityUpdated(input: { communityId: string; name: string } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'community_updated',
      data: { community_id: input.communityId, name: input.name },
    };
  },

  communityDeleted(input: { communityId: string; channelIds: string[] } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'community_deleted',
      data: { community_id: input.communityId, channel_ids: input.channelIds },
    };
  },

  channelCreated(input: {
    communityId: string;
    channelId: string;
    name: string;
    type: string;
    position: number;
  } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'channel_created',
      data: {
        community_id: input.communityId,
        channel_id: input.channelId,
        name: input.name,
        type: input.type,
        position: input.position,
      },
    };
  },

  channelUpdated(input: {
    communityId: string;
    channelId: string;
    name: string;
    type: string;
    position: number;
  } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'channel_updated',
      data: {
        community_id: input.communityId,
        channel_id: input.channelId,
        name: input.name,
        type: input.type,
        position: input.position,
      },
    };
  },

  channelDeleted(input: { communityId: string; channelId: string; type: string } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'channel_deleted',
      data: { community_id: input.communityId, channel_id: input.channelId, type: input.type },
    };
  },

  memberJoined(input: { communityId: string; userId: string } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'member_joined',
      data: { community_id: input.communityId, user_id: input.userId },
    };
  },

  memberLeft(input: { communityId: string; userId: string } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'member_left',
      data: { community_id: input.communityId, user_id: input.userId },
    };
  },

  memberRolesChanged(input: { communityId: string; userId: string; roleIds: string[] } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'member_roles_changed',
      data: { community_id: input.communityId, user_id: input.userId, role_ids: input.roleIds },
    };
  },

  rolesChanged(input: { communityId: string; roleId: string } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'roles_changed',
      data: { community_id: input.communityId, role_id: input.roleId },
    };
  },

  permissionOverwritesChanged(input: { communityId: string; channelId: string } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'permission_overwrites_changed',
      data: { community_id: input.communityId, channel_id: input.channelId },
    };
  },

  memberTimedOut(input: {
    communityId: string;
    userId: string;
    moderatorUserId: string;
    timedOutUntil: Date;
    memberMessage: string | null;
    voiceChannelIds: string[];
  } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'member_timed_out',
      data: {
        community_id: input.communityId,
        user_id: input.userId,
        moderator_user_id: input.moderatorUserId,
        timed_out_until: input.timedOutUntil.toISOString(),
        member_message: input.memberMessage,
        voice_channel_ids: input.voiceChannelIds,
      },
    };
  },

  memberTimeoutCleared(input: {
    communityId: string;
    userId: string;
    voiceChannelIds: string[];
  } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'member_timeout_cleared',
      data: {
        community_id: input.communityId,
        user_id: input.userId,
        voice_channel_ids: input.voiceChannelIds,
      },
    };
  },

  memberKicked(input: {
    communityId: string;
    userId: string;
    moderatorUserId: string;
    memberMessage: string | null;
    voiceChannelIds: string[];
  } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'member_kicked',
      data: {
        community_id: input.communityId,
        user_id: input.userId,
        moderator_user_id: input.moderatorUserId,
        member_message: input.memberMessage,
        voice_channel_ids: input.voiceChannelIds,
      },
    };
  },

  memberBanned(input: {
    communityId: string;
    userId: string;
    moderatorUserId: string;
    memberMessage: string | null;
    voiceChannelIds: string[];
    banExpiresAt: Date | null;
  } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'member_banned',
      data: {
        community_id: input.communityId,
        user_id: input.userId,
        moderator_user_id: input.moderatorUserId,
        member_message: input.memberMessage,
        voice_channel_ids: input.voiceChannelIds,
        ban_expires_at: input.banExpiresAt ? input.banExpiresAt.toISOString() : null,
      },
    };
  },

  memberUnbanned(input: { communityId: string; userId: string } & Traceable): DomainEvent {
    return {
      ...base(input.communityId, input),
      eventType: 'member_unbanned',
      data: { community_id: input.communityId, user_id: input.userId },
    };
  },
};

/** `community_invite_events` factories. */
export const inviteEvents = {
  inviteEmailRequested(input: {
    communityId: string;
    inviteCode: string;
    inviteUrl: string;
    communityName: string;
    inviterUserId: string;
    inviterUsername: string;
    recipientEmail: string;
    expiresAt: Date | null;
  } & Traceable): DomainEvent {
    return {
      topic: COMMUNITY_INVITE_EVENTS_TOPIC,
      partitionKey: input.communityId,
      traceParent: input.traceParent ?? null,
      eventType: 'invite_email_requested',
      data: {
        invite_code: input.inviteCode,
        invite_url: input.inviteUrl,
        community_id: input.communityId,
        community_name: input.communityName,
        inviter_user_id: input.inviterUserId,
        inviter_username: input.inviterUsername,
        recipient_email: input.recipientEmail,
        expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
      },
    };
  },
};
