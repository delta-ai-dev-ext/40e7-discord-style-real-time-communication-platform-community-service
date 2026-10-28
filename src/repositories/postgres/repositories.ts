import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  AuditLogEntryRow,
  BanRow,
  ChannelRow,
  ChannelType,
  CommunityRow,
  EmailInviteRow,
  InviteRow,
  MemberRoleRow,
  MembershipRow,
  OutboxEventRow,
  OutboxTopic,
  PermissionOverwriteRow,
  RoleRow,
} from '../../models/domain.ts';
import type { Permission } from '../../models/permissions.ts';
import { decodeCursor, normalizeLimit, paginate } from '../../models/pagination.ts';
import type {
  AuditLogRepository,
  BanRepository,
  ChannelRepository,
  CommunityRepository,
  EmailInviteRepository,
  InviteRepository,
  MemberRoleRepository,
  MembershipRepository,
  OutboxRepository,
  OverwriteRepository,
  Repositories,
  RoleRepository,
} from '../types.ts';
import {
  auditLogEntry,
  ban,
  channel,
  community,
  emailInvite,
  invite,
  memberRole,
  membership,
  outboxEvent,
  permissionOverwrite,
  role,
} from '../schema.ts';

/**
 * drizzle-orm data access for PostgreSQL.
 *
 * Every statement is parameterized by the query builder — no string-interpolated
 * SQL. Unique constraints arbitrate concurrency (idempotent membership insert,
 * single active ban, conditional `used_count` increment).
 */
export type Database = NodePgDatabase<Record<string, never>>;

const toPermissions = (values: string[]): Permission[] => values as Permission[];

function mapCommunity(row: typeof community.$inferSelect): CommunityRow {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapChannel(row: typeof channel.$inferSelect): ChannelRow {
  return {
    id: row.id,
    communityId: row.communityId,
    name: row.name,
    type: row.type as ChannelType,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRole(row: typeof role.$inferSelect): RoleRow {
  return {
    id: row.id,
    communityId: row.communityId,
    name: row.name,
    permissions: toPermissions(row.permissions),
    position: row.position,
    isEveryone: row.isEveryone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapMembership(row: typeof membership.$inferSelect): MembershipRow {
  return {
    id: row.id,
    communityId: row.communityId,
    userId: row.userId,
    nickname: row.nickname,
    timedOutUntil: row.timedOutUntil,
    joinedAt: row.joinedAt,
  };
}

function mapMemberRole(row: typeof memberRole.$inferSelect): MemberRoleRow {
  return {
    communityId: row.communityId,
    userId: row.userId,
    roleId: row.roleId,
    assignedBy: row.assignedBy,
    assignedAt: row.assignedAt,
  };
}

function mapOverwrite(row: typeof permissionOverwrite.$inferSelect): PermissionOverwriteRow {
  return {
    id: row.id,
    channelId: row.channelId,
    targetType: row.targetType as PermissionOverwriteRow['targetType'],
    targetId: row.targetId,
    allow: toPermissions(row.allow),
    deny: toPermissions(row.deny),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapBan(row: typeof ban.$inferSelect): BanRow {
  return {
    id: row.id,
    communityId: row.communityId,
    userId: row.userId,
    reason: row.reason,
    memberMessage: row.memberMessage,
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

function mapInvite(row: typeof invite.$inferSelect): InviteRow {
  return {
    id: row.id,
    communityId: row.communityId,
    code: row.code,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    revoked: row.revoked,
    createdAt: row.createdAt,
  };
}

function mapEmailInvite(row: typeof emailInvite.$inferSelect): EmailInviteRow {
  return {
    id: row.id,
    inviteId: row.inviteId,
    communityId: row.communityId,
    recipientEmail: row.recipientEmail,
    communityName: row.communityName,
    inviterUserId: row.inviterUserId,
    inviterUsername: row.inviterUsername,
    status: row.status as EmailInviteRow['status'],
    createdAt: row.createdAt,
  };
}

function mapAuditEntry(row: typeof auditLogEntry.$inferSelect): AuditLogEntryRow {
  return {
    id: row.id,
    communityId: row.communityId,
    actorUserId: row.actorUserId,
    action: row.action as AuditLogEntryRow['action'],
    target: row.target,
    reason: row.reason,
    changes: (row.changes ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

function mapOutbox(row: typeof outboxEvent.$inferSelect): OutboxEventRow {
  return {
    id: row.id,
    topic: row.topic as OutboxTopic,
    eventType: row.eventType,
    partitionKey: row.partitionKey,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    traceParent: row.traceParent,
    status: row.status as OutboxEventRow['status'],
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
  };
}

export function createCommunityRepository(db: Database): CommunityRepository {
  return {
    async insert(row) {
      const [created] = await db.insert(community).values(row).returning();
      return mapCommunity(created as typeof community.$inferSelect);
    },
    async findById(id) {
      const [found] = await db.select().from(community).where(eq(community.id, id)).limit(1);
      return found ? mapCommunity(found) : null;
    },
    async updateName(id, name, updatedAt) {
      const [updated] = await db
        .update(community)
        .set({ name, updatedAt })
        .where(eq(community.id, id))
        .returning();
      return updated ? mapCommunity(updated) : null;
    },
    async deleteById(id) {
      const deleted = await db
        .delete(community)
        .where(eq(community.id, id))
        .returning({ id: community.id });
      return deleted.length > 0;
    },
    async listByMember(userId) {
      const rows = await db
        .select({ community })
        .from(membership)
        .innerJoin(community, eq(community.id, membership.communityId))
        .where(eq(membership.userId, userId))
        .orderBy(asc(membership.joinedAt), asc(community.id));
      return rows.map((row) => mapCommunity(row.community));
    },
  };
}

export function createChannelRepository(db: Database): ChannelRepository {
  return {
    async insert(row) {
      const [created] = await db.insert(channel).values(row).returning();
      return mapChannel(created as typeof channel.$inferSelect);
    },
    async findById(id) {
      const [found] = await db.select().from(channel).where(eq(channel.id, id)).limit(1);
      return found ? mapChannel(found) : null;
    },
    async listByCommunity(communityId) {
      const rows = await db
        .select()
        .from(channel)
        .where(eq(channel.communityId, communityId))
        .orderBy(asc(channel.position), asc(channel.name), asc(channel.id));
      return rows.map(mapChannel);
    },
    async listIdsByCommunity(communityId) {
      const rows = await db
        .select({ id: channel.id })
        .from(channel)
        .where(eq(channel.communityId, communityId));
      return rows.map((row) => row.id);
    },
    async update(id, patch) {
      const values: Record<string, unknown> = { updatedAt: patch.updatedAt };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.position !== undefined) values.position = patch.position;
      const [updated] = await db.update(channel).set(values).where(eq(channel.id, id)).returning();
      return updated ? mapChannel(updated) : null;
    },
    async deleteById(id) {
      const deleted = await db.delete(channel).where(eq(channel.id, id)).returning({ id: channel.id });
      return deleted.length > 0;
    },
  };
}

export function createRoleRepository(db: Database): RoleRepository {
  return {
    async insert(row) {
      const [created] = await db.insert(role).values(row).returning();
      return mapRole(created as typeof role.$inferSelect);
    },
    async findById(id) {
      const [found] = await db.select().from(role).where(eq(role.id, id)).limit(1);
      return found ? mapRole(found) : null;
    },
    async listByCommunity(communityId) {
      const rows = await db
        .select()
        .from(role)
        .where(eq(role.communityId, communityId))
        .orderBy(desc(role.position), asc(role.id));
      return rows.map(mapRole);
    },
    async findEveryone(communityId) {
      const [found] = await db
        .select()
        .from(role)
        .where(and(eq(role.communityId, communityId), eq(role.isEveryone, true)))
        .limit(1);
      return found ? mapRole(found) : null;
    },
    async update(id, patch) {
      const values: Record<string, unknown> = { updatedAt: patch.updatedAt };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.permissions !== undefined) values.permissions = patch.permissions;
      if (patch.position !== undefined) values.position = patch.position;
      const [updated] = await db.update(role).set(values).where(eq(role.id, id)).returning();
      return updated ? mapRole(updated) : null;
    },
    async deleteById(id) {
      const deleted = await db.delete(role).where(eq(role.id, id)).returning({ id: role.id });
      return deleted.length > 0;
    },
  };
}

export function createMembershipRepository(db: Database): MembershipRepository {
  return {
    async insert(row) {
      // ON CONFLICT DO NOTHING: the unique (community_id, user_id) constraint
      // makes invite acceptance idempotent under concurrent accepts.
      const [created] = await db
        .insert(membership)
        .values(row)
        .onConflictDoNothing({ target: [membership.communityId, membership.userId] })
        .returning();
      return created ? mapMembership(created) : null;
    },
    async find(communityId, userId) {
      const [found] = await db
        .select()
        .from(membership)
        .where(and(eq(membership.communityId, communityId), eq(membership.userId, userId)))
        .limit(1);
      return found ? mapMembership(found) : null;
    },
    async listByCommunity(communityId, query = {}) {
      const limit = normalizeLimit(query.limit);
      const cursor = decodeCursor(query.cursor);
      const cursorFilter = cursor
        ? or(
            gt(membership.joinedAt, cursor.createdAt),
            and(eq(membership.joinedAt, cursor.createdAt), gt(membership.id, cursor.id)),
          )
        : undefined;
      const rows = await db
        .select()
        .from(membership)
        .where(
          cursorFilter
            ? and(eq(membership.communityId, communityId), cursorFilter)
            : eq(membership.communityId, communityId),
        )
        .orderBy(asc(membership.joinedAt), asc(membership.id))
        .limit(limit + 1);
      return paginate(rows.map(mapMembership), limit, (row) => row.joinedAt);
    },
    async listByUser(userId) {
      const rows = await db.select().from(membership).where(eq(membership.userId, userId));
      return rows.map(mapMembership);
    },
    async updateNickname(communityId, userId, nickname) {
      const [updated] = await db
        .update(membership)
        .set({ nickname })
        .where(and(eq(membership.communityId, communityId), eq(membership.userId, userId)))
        .returning();
      return updated ? mapMembership(updated) : null;
    },
    async setTimedOutUntil(communityId, userId, timedOutUntil) {
      const [updated] = await db
        .update(membership)
        .set({ timedOutUntil })
        .where(and(eq(membership.communityId, communityId), eq(membership.userId, userId)))
        .returning();
      return updated ? mapMembership(updated) : null;
    },
    async delete(communityId, userId) {
      const deleted = await db
        .delete(membership)
        .where(and(eq(membership.communityId, communityId), eq(membership.userId, userId)))
        .returning({ id: membership.id });
      return deleted.length > 0;
    },
    async countByCommunity(communityId) {
      const [row] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(membership)
        .where(eq(membership.communityId, communityId));
      return Number(row?.value ?? 0);
    },
  };
}

export function createMemberRoleRepository(db: Database): MemberRoleRepository {
  return {
    async assign(row) {
      await db
        .insert(memberRole)
        .values(row)
        .onConflictDoNothing({
          target: [memberRole.communityId, memberRole.userId, memberRole.roleId],
        });
    },
    async remove(communityId, userId, roleId) {
      const deleted = await db
        .delete(memberRole)
        .where(
          and(
            eq(memberRole.communityId, communityId),
            eq(memberRole.userId, userId),
            eq(memberRole.roleId, roleId),
          ),
        )
        .returning({ roleId: memberRole.roleId });
      return deleted.length > 0;
    },
    async listForMember(communityId, userId) {
      const rows = await db
        .select()
        .from(memberRole)
        .where(and(eq(memberRole.communityId, communityId), eq(memberRole.userId, userId)));
      return rows.map(mapMemberRole);
    },
    async listByCommunity(communityId) {
      const rows = await db.select().from(memberRole).where(eq(memberRole.communityId, communityId));
      return rows.map(mapMemberRole);
    },
    async deleteForMember(communityId, userId) {
      const deleted = await db
        .delete(memberRole)
        .where(and(eq(memberRole.communityId, communityId), eq(memberRole.userId, userId)))
        .returning({ roleId: memberRole.roleId });
      return deleted.length;
    },
  };
}

export function createOverwriteRepository(db: Database): OverwriteRepository {
  return {
    async upsert(row) {
      const [stored] = await db
        .insert(permissionOverwrite)
        .values(row)
        .onConflictDoUpdate({
          target: [
            permissionOverwrite.channelId,
            permissionOverwrite.targetType,
            permissionOverwrite.targetId,
          ],
          set: { allow: row.allow, deny: row.deny, updatedAt: row.updatedAt },
        })
        .returning();
      return mapOverwrite(stored as typeof permissionOverwrite.$inferSelect);
    },
    async find(channelId, targetType, targetId) {
      const [found] = await db
        .select()
        .from(permissionOverwrite)
        .where(
          and(
            eq(permissionOverwrite.channelId, channelId),
            eq(permissionOverwrite.targetType, targetType),
            eq(permissionOverwrite.targetId, targetId),
          ),
        )
        .limit(1);
      return found ? mapOverwrite(found) : null;
    },
    async listByChannel(channelId) {
      const rows = await db
        .select()
        .from(permissionOverwrite)
        .where(eq(permissionOverwrite.channelId, channelId));
      return rows.map(mapOverwrite);
    },
    async listByCommunity(communityId) {
      const rows = await db
        .select({ overwrite: permissionOverwrite })
        .from(permissionOverwrite)
        .innerJoin(channel, eq(channel.id, permissionOverwrite.channelId))
        .where(eq(channel.communityId, communityId));
      return rows.map((row) => mapOverwrite(row.overwrite));
    },
    async delete(channelId, targetType, targetId) {
      const deleted = await db
        .delete(permissionOverwrite)
        .where(
          and(
            eq(permissionOverwrite.channelId, channelId),
            eq(permissionOverwrite.targetType, targetType),
            eq(permissionOverwrite.targetId, targetId),
          ),
        )
        .returning({ id: permissionOverwrite.id });
      return deleted.length > 0;
    },
  };
}

export function createBanRepository(db: Database): BanRepository {
  return {
    async upsert(row) {
      const [stored] = await db
        .insert(ban)
        .values(row)
        .onConflictDoUpdate({
          target: [ban.communityId, ban.userId],
          set: {
            reason: row.reason,
            memberMessage: row.memberMessage,
            expiresAt: row.expiresAt,
            createdBy: row.createdBy,
            createdAt: row.createdAt,
          },
        })
        .returning();
      return mapBan(stored as typeof ban.$inferSelect);
    },
    async find(communityId, userId) {
      const [found] = await db
        .select()
        .from(ban)
        .where(and(eq(ban.communityId, communityId), eq(ban.userId, userId)))
        .limit(1);
      return found ? mapBan(found) : null;
    },
    async findActive(communityId, userId, now) {
      const [found] = await db
        .select()
        .from(ban)
        .where(
          and(
            eq(ban.communityId, communityId),
            eq(ban.userId, userId),
            or(isNull(ban.expiresAt), gt(ban.expiresAt, now)),
          ),
        )
        .limit(1);
      return found ? mapBan(found) : null;
    },
    async listByCommunity(communityId, query = {}) {
      const limit = normalizeLimit(query.limit);
      const cursor = decodeCursor(query.cursor);
      const cursorFilter = cursor
        ? or(
            lt(ban.createdAt, cursor.createdAt),
            and(eq(ban.createdAt, cursor.createdAt), lt(ban.id, cursor.id)),
          )
        : undefined;
      const rows = await db
        .select()
        .from(ban)
        .where(
          cursorFilter
            ? and(eq(ban.communityId, communityId), cursorFilter)
            : eq(ban.communityId, communityId),
        )
        .orderBy(desc(ban.createdAt), desc(ban.id))
        .limit(limit + 1);
      return paginate(rows.map(mapBan), limit, (row) => row.createdAt);
    },
    async delete(communityId, userId) {
      const deleted = await db
        .delete(ban)
        .where(and(eq(ban.communityId, communityId), eq(ban.userId, userId)))
        .returning({ id: ban.id });
      return deleted.length > 0;
    },
  };
}

export function createInviteRepository(db: Database): InviteRepository {
  return {
    async insert(row) {
      const [created] = await db.insert(invite).values(row).returning();
      return mapInvite(created as typeof invite.$inferSelect);
    },
    async findByCode(code) {
      const [found] = await db.select().from(invite).where(eq(invite.code, code)).limit(1);
      return found ? mapInvite(found) : null;
    },
    async findById(id) {
      const [found] = await db.select().from(invite).where(eq(invite.id, id)).limit(1);
      return found ? mapInvite(found) : null;
    },
    async listActiveByCommunity(communityId) {
      const rows = await db
        .select()
        .from(invite)
        .where(and(eq(invite.communityId, communityId), eq(invite.revoked, false)))
        .orderBy(desc(invite.createdAt), asc(invite.id));
      return rows.map(mapInvite);
    },
    async revoke(communityId, code) {
      const [updated] = await db
        .update(invite)
        .set({ revoked: true })
        .where(and(eq(invite.communityId, communityId), eq(invite.code, code)))
        .returning();
      return updated ? mapInvite(updated) : null;
    },
    async incrementUsedCount(id, maxUses) {
      const guard =
        maxUses === null
          ? and(eq(invite.id, id), eq(invite.revoked, false))
          : and(eq(invite.id, id), eq(invite.revoked, false), sql`${invite.usedCount} < ${maxUses}`);
      const updated = await db
        .update(invite)
        .set({ usedCount: sql`${invite.usedCount} + 1` })
        .where(guard)
        .returning({ id: invite.id });
      return updated.length > 0;
    },
  };
}

export function createEmailInviteRepository(db: Database): EmailInviteRepository {
  return {
    async insert(row) {
      const [created] = await db.insert(emailInvite).values(row).returning();
      return mapEmailInvite(created as typeof emailInvite.$inferSelect);
    },
    async findByInviteId(inviteId) {
      const [found] = await db
        .select()
        .from(emailInvite)
        .where(eq(emailInvite.inviteId, inviteId))
        .limit(1);
      return found ? mapEmailInvite(found) : null;
    },
  };
}

export function createAuditLogRepository(db: Database): AuditLogRepository {
  return {
    async insert(row) {
      const [created] = await db.insert(auditLogEntry).values(row).returning();
      return mapAuditEntry(created as typeof auditLogEntry.$inferSelect);
    },
    async list(communityId, filters = {}) {
      const limit = normalizeLimit(filters.limit);
      const cursor = decodeCursor(filters.cursor);
      const conditions = [eq(auditLogEntry.communityId, communityId)];
      if (filters.action) conditions.push(eq(auditLogEntry.action, filters.action));
      if (filters.actorUserId) conditions.push(eq(auditLogEntry.actorUserId, filters.actorUserId));
      if (filters.target) conditions.push(eq(auditLogEntry.target, filters.target));
      const senior = cursor
        ? or(
            lt(auditLogEntry.createdAt, cursor.createdAt),
            and(eq(auditLogEntry.createdAt, cursor.createdAt), lt(auditLogEntry.id, cursor.id)),
          )
        : undefined;
      const rows = await db
        .select()
        .from(auditLogEntry)
        .where(senior ? and(...conditions, senior) : and(...conditions))
        .orderBy(desc(auditLogEntry.createdAt), desc(auditLogEntry.id))
        .limit(limit + 1);
      return paginate(rows.map(mapAuditEntry), limit, (row) => row.createdAt);
    },
  };
}

export function createOutboxRepository(db: Database): OutboxRepository {
  return {
    async insert(row) {
      const [created] = await db.insert(outboxEvent).values(row).returning();
      return mapOutbox(created as typeof outboxEvent.$inferSelect);
    },
    async listPending(limit) {
      const rows = await db
        .select()
        .from(outboxEvent)
        .where(eq(outboxEvent.status, 'pending'))
        .orderBy(asc(outboxEvent.partitionKey), asc(outboxEvent.createdAt), asc(outboxEvent.id))
        .limit(limit);
      return rows.map(mapOutbox);
    },
    async markPublished(ids, publishedAt) {
      if (ids.length === 0) return 0;
      const updated = await db
        .update(outboxEvent)
        .set({ status: 'published', publishedAt })
        .where(and(inArray(outboxEvent.id, ids), eq(outboxEvent.status, 'pending')))
        .returning({ id: outboxEvent.id });
      return updated.length;
    },
    async oldestPendingCreatedAt() {
      const [row] = await db
        .select({ value: sql<Date | null>`min(${outboxEvent.createdAt})` })
        .from(outboxEvent)
        .where(eq(outboxEvent.status, 'pending'));
      return row?.value ?? null;
    },
  };
}

export function createPostgresRepositories(db: Database): Repositories {
  return {
    community: createCommunityRepository(db),
    channel: createChannelRepository(db),
    role: createRoleRepository(db),
    membership: createMembershipRepository(db),
    memberRole: createMemberRoleRepository(db),
    overwrite: createOverwriteRepository(db),
    ban: createBanRepository(db),
    invite: createInviteRepository(db),
    emailInvite: createEmailInviteRepository(db),
    auditLog: createAuditLogRepository(db),
    outbox: createOutboxRepository(db),
  };
}
