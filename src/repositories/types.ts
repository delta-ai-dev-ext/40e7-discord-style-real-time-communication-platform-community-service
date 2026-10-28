import type {
  AuditAction,
  AuditLogEntryRow,
  BanRow,
  ChannelRow,
  CommunityRow,
  EmailInviteRow,
  InviteRow,
  MemberRoleRow,
  MembershipRow,
  OutboxEventRow,
  PermissionOverwriteRow,
  RoleRow,
} from '../models/domain.ts';

/**
 * Persistence contracts.
 *
 * Services depend only on these interfaces, never on drizzle/pg directly, so
 * unit tests run against in-memory fakes and the production adapter can change
 * without touching business rules (docs/engineering_guide.md layering rule).
 */
export interface PageQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CommunityRepository {
  insert(row: CommunityRow): Promise<CommunityRow>;
  findById(id: string): Promise<CommunityRow | null>;
  updateName(id: string, name: string, updatedAt: Date): Promise<CommunityRow | null>;
  deleteById(id: string): Promise<boolean>;
  /** Communities the user is a member of, oldest membership first. */
  listByMember(userId: string): Promise<CommunityRow[]>;
}

export interface ChannelRepository {
  insert(row: ChannelRow): Promise<ChannelRow>;
  findById(id: string): Promise<ChannelRow | null>;
  listByCommunity(communityId: string): Promise<ChannelRow[]>;
  listIdsByCommunity(communityId: string): Promise<string[]>;
  update(
    id: string,
    patch: { name?: string; position?: number; updatedAt: Date },
  ): Promise<ChannelRow | null>;
  deleteById(id: string): Promise<boolean>;
}

export interface RoleRepository {
  insert(row: RoleRow): Promise<RoleRow>;
  findById(id: string): Promise<RoleRow | null>;
  /** Roles ordered by position (highest first). */
  listByCommunity(communityId: string): Promise<RoleRow[]>;
  findEveryone(communityId: string): Promise<RoleRow | null>;
  update(
    id: string,
    patch: { name?: string; permissions?: RoleRow['permissions']; position?: number; updatedAt: Date },
  ): Promise<RoleRow | null>;
  deleteById(id: string): Promise<boolean>;
}

export interface MembershipRepository {
  /**
   * Inserts a membership. Returns `null` when `(community_id, user_id)` already
   * exists — the unique constraint is the idempotency arbiter for invite accept.
   */
  insert(row: MembershipRow): Promise<MembershipRow | null>;
  find(communityId: string, userId: string): Promise<MembershipRow | null>;
  listByCommunity(communityId: string, query?: PageQuery): Promise<Page<MembershipRow>>;
  listByUser(userId: string): Promise<MembershipRow[]>;
  updateNickname(communityId: string, userId: string, nickname: string | null): Promise<MembershipRow | null>;
  setTimedOutUntil(
    communityId: string,
    userId: string,
    timedOutUntil: Date | null,
  ): Promise<MembershipRow | null>;
  delete(communityId: string, userId: string): Promise<boolean>;
  countByCommunity(communityId: string): Promise<number>;
}

export interface MemberRoleRepository {
  /** Idempotent: assigning an already-assigned role is a no-op. */
  assign(row: MemberRoleRow): Promise<void>;
  remove(communityId: string, userId: string, roleId: string): Promise<boolean>;
  listForMember(communityId: string, userId: string): Promise<MemberRoleRow[]>;
  listByCommunity(communityId: string): Promise<MemberRoleRow[]>;
  deleteForMember(communityId: string, userId: string): Promise<number>;
}

export interface OverwriteRepository {
  /** Upsert on `(channel_id, target_type, target_id)`. */
  upsert(row: PermissionOverwriteRow): Promise<PermissionOverwriteRow>;
  find(channelId: string, targetType: string, targetId: string): Promise<PermissionOverwriteRow | null>;
  listByChannel(channelId: string): Promise<PermissionOverwriteRow[]>;
  listByCommunity(communityId: string): Promise<PermissionOverwriteRow[]>;
  delete(channelId: string, targetType: string, targetId: string): Promise<boolean>;
}

export interface BanRepository {
  /** Upsert on `(community_id, user_id)`. */
  upsert(row: BanRow): Promise<BanRow>;
  find(communityId: string, userId: string): Promise<BanRow | null>;
  /** A ban is active when it exists and (`expires_at` is NULL or in the future). */
  findActive(communityId: string, userId: string, now: Date): Promise<BanRow | null>;
  listByCommunity(communityId: string, query?: PageQuery): Promise<Page<BanRow>>;
  delete(communityId: string, userId: string): Promise<boolean>;
}

export interface InviteRepository {
  insert(row: InviteRow): Promise<InviteRow>;
  findByCode(code: string): Promise<InviteRow | null>;
  findById(id: string): Promise<InviteRow | null>;
  listActiveByCommunity(communityId: string): Promise<InviteRow[]>;
  revoke(communityId: string, code: string): Promise<InviteRow | null>;
  /**
   * Atomic usage increment guarded by `max_uses`.
   * Returns `false` when the invite is already exhausted (no row updated).
   */
  incrementUsedCount(id: string, maxUses: number | null): Promise<boolean>;
}

export interface EmailInviteRepository {
  insert(row: EmailInviteRow): Promise<EmailInviteRow>;
  findByInviteId(inviteId: string): Promise<EmailInviteRow | null>;
}

export interface AuditLogFilters extends PageQuery {
  action?: AuditAction | undefined;
  actorUserId?: string | undefined;
  target?: string | undefined;
}

export interface AuditLogRepository {
  insert(row: AuditLogEntryRow): Promise<AuditLogEntryRow>;
  /** Newest first. */
  list(communityId: string, filters?: AuditLogFilters): Promise<Page<AuditLogEntryRow>>;
}

export interface OutboxRepository {
  insert(row: OutboxEventRow): Promise<OutboxEventRow>;
  /** Pending rows in `(partition_key, created_at, id)` order (per-community ordering). */
  listPending(limit: number): Promise<OutboxEventRow[]>;
  markPublished(ids: string[], publishedAt: Date): Promise<number>;
  oldestPendingCreatedAt(): Promise<Date | null>;
}

/** All repositories, available both outside and inside a transaction. */
export interface Repositories {
  community: CommunityRepository;
  channel: ChannelRepository;
  role: RoleRepository;
  membership: MembershipRepository;
  memberRole: MemberRoleRepository;
  overwrite: OverwriteRepository;
  ban: BanRepository;
  invite: InviteRepository;
  emailInvite: EmailInviteRepository;
  auditLog: AuditLogRepository;
  outbox: OutboxRepository;
}

/**
 * Runs `fn` inside a single database transaction.
 * State change + audit entry + outbox row must share this boundary.
 */
export type TransactionRunner = <T>(fn: (repos: Repositories) => Promise<T>) => Promise<T>;
