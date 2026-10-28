import type {
  AuditLogEntryRow,
  BanRow,
  ChannelRow,
  CommunityRow,
  InviteRow,
  MembershipRow,
  PermissionOverwriteRow,
  RoleRow,
} from './domain.ts';
import type { Permission } from './permissions.ts';

/**
 * Response mappers: the single place where persistence rows become the exact
 * JSON shapes of docs/openapi_spec.yaml. Timestamps are ISO-8601 strings.
 */
export interface ChannelDto {
  id: string;
  community_id: string;
  name: string;
  type: string;
  position: number;
  created_at: string;
}

export interface RoleDto {
  id: string;
  community_id: string;
  name: string;
  permissions: Permission[];
  position: number;
  is_everyone: boolean;
  created_at: string;
}

export interface CommunityDto {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
  member_count?: number;
}

export interface CommunityDetailDto extends CommunityDto {
  channels: ChannelDto[];
  effective_permissions: Permission[];
}

export interface MembershipDto {
  community_id: string;
  user_id: string;
  roles: string[];
  nickname: string | null;
  timed_out_until: string | null;
  joined_at: string;
}

export interface MemberDto {
  user_id: string;
  roles: string[];
  nickname: string | null;
  timed_out_until: string | null;
  joined_at: string;
}

export interface InviteDto {
  code: string;
  community_id: string;
  url: string;
  inviter_user_id: string;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  used_count: number;
  revoked: boolean;
}

export interface BanDto {
  community_id: string;
  user_id: string;
  reason: string;
  member_message: string | null;
  expires_at: string | null;
  created_by: string;
  created_at: string;
}

export interface AuditLogEntryDto {
  id: string;
  community_id: string;
  actor_user_id: string;
  action: string;
  target: string;
  reason: string | null;
  changes_summary: Record<string, unknown>;
  created_at: string;
}

export interface PermissionOverwriteDto {
  channel_id: string;
  target_type: string;
  target_id: string;
  allow: Permission[];
  deny: Permission[];
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toChannel(row: ChannelRow): ChannelDto {
  return {
    id: row.id,
    community_id: row.communityId,
    name: row.name,
    type: row.type,
    position: row.position,
    created_at: row.createdAt.toISOString(),
  };
}

export function toRole(row: RoleRow): RoleDto {
  return {
    id: row.id,
    community_id: row.communityId,
    name: row.name,
    permissions: row.permissions,
    position: row.position,
    is_everyone: row.isEveryone,
    created_at: row.createdAt.toISOString(),
  };
}

export function toCommunity(row: CommunityRow, memberCount?: number): CommunityDto {
  const dto: CommunityDto = {
    id: row.id,
    name: row.name,
    owner_user_id: row.ownerUserId,
    created_at: row.createdAt.toISOString(),
  };
  if (memberCount !== undefined) dto.member_count = memberCount;
  return dto;
}

export function toCommunityDetail(
  row: CommunityRow,
  channels: ChannelRow[],
  effectivePermissions: Permission[],
  memberCount?: number,
): CommunityDetailDto {
  return {
    ...toCommunity(row, memberCount),
    channels: channels.map(toChannel),
    effective_permissions: effectivePermissions,
  };
}

export function toMembership(row: MembershipRow, roleIds: string[]): MembershipDto {
  return {
    community_id: row.communityId,
    user_id: row.userId,
    roles: roleIds,
    nickname: row.nickname,
    timed_out_until: iso(row.timedOutUntil),
    joined_at: row.joinedAt.toISOString(),
  };
}

export function toMember(row: MembershipRow, roleIds: string[]): MemberDto {
  return {
    user_id: row.userId,
    roles: roleIds,
    nickname: row.nickname,
    timed_out_until: iso(row.timedOutUntil),
    joined_at: row.joinedAt.toISOString(),
  };
}

export function inviteUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${code}`;
}

export function toInvite(row: InviteRow, baseUrl: string): InviteDto {
  return {
    code: row.code,
    community_id: row.communityId,
    url: inviteUrl(baseUrl, row.code),
    inviter_user_id: row.createdBy,
    created_at: row.createdAt.toISOString(),
    expires_at: iso(row.expiresAt),
    max_uses: row.maxUses,
    used_count: row.usedCount,
    revoked: row.revoked,
  };
}

export function toBan(row: BanRow): BanDto {
  return {
    community_id: row.communityId,
    user_id: row.userId,
    reason: row.reason,
    member_message: row.memberMessage,
    expires_at: iso(row.expiresAt),
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  };
}

export function toAuditLogEntry(row: AuditLogEntryRow): AuditLogEntryDto {
  return {
    id: row.id,
    community_id: row.communityId,
    actor_user_id: row.actorUserId,
    action: row.action,
    target: row.target,
    reason: row.reason,
    changes_summary: row.changes,
    created_at: row.createdAt.toISOString(),
  };
}

export function toPermissionOverwrite(row: PermissionOverwriteRow): PermissionOverwriteDto {
  return {
    channel_id: row.channelId,
    target_type: row.targetType,
    target_id: row.targetId,
    allow: row.allow,
    deny: row.deny,
  };
}
