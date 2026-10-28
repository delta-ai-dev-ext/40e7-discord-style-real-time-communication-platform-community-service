import type {
  AuditLogEntryDto,
  BanDto,
  ChannelDto,
  CommunityDetailDto,
  InviteDto,
  MemberDto,
  MembershipDto,
  PermissionOverwriteDto,
  RoleDto,
} from './responses.ts';

/** Collection DTOs from docs/openapi_spec.yaml. */
export interface MemberListDto {
  members: MemberDto[];
  next_cursor: string | null;
}

export interface BanListDto {
  bans: BanDto[];
  next_cursor: string | null;
}

export interface AuditLogListDto {
  entries: AuditLogEntryDto[];
  next_cursor: string | null;
}

export interface RoleListDto {
  roles: RoleDto[];
}

export interface InviteListDto {
  invites: InviteDto[];
}

export interface MyCommunityListDto {
  communities: CommunityDetailDto[];
}

export interface InvitePreviewDto {
  community_name: string;
  member_count: number;
  inviter_username: string | null;
  expires_at: string | null;
}

export interface EmailInviteAcceptedDto {
  invite_code: string;
  status: 'queued';
}

export interface ChannelAccessDto {
  community_id: string;
  channel_type: 'text' | 'voice';
  is_member: boolean;
  can_view: boolean;
  can_read_history: boolean;
  can_send: boolean;
  can_connect: boolean;
  can_speak: boolean;
  can_video: boolean;
  timed_out_until: string | null;
  banned: boolean;
}

export interface MemberAccessDto {
  is_member: boolean;
  banned: boolean;
  visible_channel_ids: string[];
  timed_out_until: string | null;
}

export interface HealthStatusDto {
  status: 'ok' | 'unavailable';
}

export type {
  AuditLogEntryDto,
  BanDto,
  ChannelDto,
  CommunityDetailDto,
  InviteDto,
  MemberDto,
  MembershipDto,
  PermissionOverwriteDto,
  RoleDto,
};
