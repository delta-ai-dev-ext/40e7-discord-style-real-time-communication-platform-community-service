import type { Permission } from './permissions.ts';

/** Channel kinds admitted by `channel.type CHECK (type IN ('text','voice'))`. */
export type ChannelType = 'text' | 'voice';

/** Overwrite target kinds (`permission_overwrite.target_type`). */
export type OverwriteTargetType = 'role' | 'member';

/** Fixed audit action vocabulary (docs/architecture.md §5). */
export const AUDIT_ACTIONS = [
  'community_renamed',
  'community_deleted',
  'channel_created',
  'channel_updated',
  'channel_deleted',
  'role_created',
  'role_updated',
  'role_deleted',
  'permission_overwrite_set',
  'permission_overwrite_removed',
  'member_role_assigned',
  'member_role_removed',
  'invite_created',
  'invite_revoked',
  'email_invite_created',
  'member_timed_out',
  'member_timeout_cleared',
  'member_kicked',
  'member_banned',
  'member_unbanned',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const AUDIT_ACTION_SET: ReadonlySet<string> = new Set<string>(AUDIT_ACTIONS);

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && AUDIT_ACTION_SET.has(value);
}

export type OutboxTopic = 'community_events' | 'community_invite_events';
export type OutboxStatus = 'pending' | 'published';

/** `community` row. */
export interface CommunityRow {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** `channel` row. */
export interface ChannelRow {
  id: string;
  communityId: string;
  name: string;
  type: ChannelType;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/** `role` row; `isEveryone` marks the implicit `@everyone` role. */
export interface RoleRow {
  id: string;
  communityId: string;
  name: string;
  permissions: Permission[];
  position: number;
  isEveryone: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** `membership` row; unique on `(community_id, user_id)`. */
export interface MembershipRow {
  id: string;
  communityId: string;
  userId: string;
  nickname: string | null;
  timedOutUntil: Date | null;
  joinedAt: Date;
}

/** `member_role` row; PK `(community_id, user_id, role_id)`. */
export interface MemberRoleRow {
  communityId: string;
  userId: string;
  roleId: string;
  assignedBy: string;
  assignedAt: Date;
}

/** `permission_overwrite` row; unique on `(channel_id, target_type, target_id)`. */
export interface PermissionOverwriteRow {
  id: string;
  channelId: string;
  targetType: OverwriteTargetType;
  targetId: string;
  allow: Permission[];
  deny: Permission[];
  createdAt: Date;
  updatedAt: Date;
}

/** `ban` row; unique on `(community_id, user_id)`; NULL `expiresAt` = permanent. */
export interface BanRow {
  id: string;
  communityId: string;
  userId: string;
  reason: string;
  memberMessage: string | null;
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

/** `invite` row; `code` is globally unique. */
export interface InviteRow {
  id: string;
  communityId: string;
  code: string;
  createdBy: string;
  expiresAt: Date | null;
  maxUses: number | null;
  usedCount: number;
  revoked: boolean;
  createdAt: Date;
}

/** `email_invite` row; snapshots everything the notification pipeline needs. */
export interface EmailInviteRow {
  id: string;
  inviteId: string;
  communityId: string;
  recipientEmail: string;
  communityName: string;
  inviterUserId: string;
  inviterUsername: string;
  status: 'queued' | 'emitted';
  createdAt: Date;
}

/** `audit_log_entry` row. */
export interface AuditLogEntryRow {
  id: string;
  communityId: string;
  actorUserId: string;
  action: AuditAction;
  target: string;
  reason: string | null;
  changes: Record<string, unknown>;
  createdAt: Date;
}

/** `outbox_event` row; `id` is the event envelope `event_id`. */
export interface OutboxEventRow {
  id: string;
  topic: OutboxTopic;
  eventType: string;
  partitionKey: string;
  payload: Record<string, unknown>;
  traceParent: string | null;
  status: OutboxStatus;
  createdAt: Date;
  publishedAt: Date | null;
}

/** Authenticated platform user derived from the Clerk session JWT claims. */
export interface AuthenticatedUser {
  userId: string;
  username: string | null;
  email: string | null;
}
