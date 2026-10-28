import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * PostgreSQL schema — exactly docs/architecture.md §5.
 *
 * All identifiers are UUIDv4 except `user_id` (Clerk user id, text) and invite
 * `code` (crypto-random, URL-safe). All timestamps are `timestamptz`.
 * Migrations are generated with drizzle-kit (`make db-generate`).
 */

export const community = pgTable(
  'community',
  {
    id: uuid('id').primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('community_name_length', sql`length(${table.name}) >= 1`)],
);

export const channel = pgTable(
  'channel',
  {
    id: uuid('id').primaryKey(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => community.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    type: text('type').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('channel_community_position_idx').on(table.communityId, table.position),
    check('channel_name_length', sql`length(${table.name}) >= 1`),
    check('channel_type_allowed', sql`${table.type} in ('text','voice')`),
  ],
);

export const role = pgTable(
  'role',
  {
    id: uuid('id').primaryKey(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => community.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    permissions: text('permissions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    position: integer('position').notNull(),
    isEveryone: boolean('is_everyone').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('role_community_position_idx').on(table.communityId, table.position),
    uniqueIndex('role_community_everyone_unique')
      .on(table.communityId)
      .where(sql`${table.isEveryone} = true`),
  ],
);

export const membership = pgTable(
  'membership',
  {
    id: uuid('id').primaryKey(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => community.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    nickname: text('nickname'),
    timedOutUntil: timestamp('timed_out_until', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('membership_community_user_unique').on(table.communityId, table.userId),
    index('membership_user_idx').on(table.userId),
  ],
);

export const memberRole = pgTable(
  'member_role',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => community.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    assignedBy: text('assigned_by').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.communityId, table.userId, table.roleId] })],
);

export const permissionOverwrite = pgTable(
  'permission_overwrite',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    allow: text('allow')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    deny: text('deny')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('permission_overwrite_target_unique').on(table.channelId, table.targetType, table.targetId),
    check('permission_overwrite_target_type_allowed', sql`${table.targetType} in ('role','member')`),
    check('permission_overwrite_no_overlap', sql`not (${table.allow} && ${table.deny})`),
  ],
);

export const ban = pgTable(
  'ban',
  {
    id: uuid('id').primaryKey(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => community.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    reason: text('reason').notNull(),
    memberMessage: text('member_message'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ban_community_user_unique').on(table.communityId, table.userId)],
);

export const invite = pgTable(
  'invite',
  {
    id: uuid('id').primaryKey(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => community.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 32 }).notNull().unique(),
    createdBy: text('created_by').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').notNull().default(0),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('invite_community_active_idx')
      .on(table.communityId)
      .where(sql`${table.revoked} = false`),
    check('invite_max_uses_positive', sql`${table.maxUses} is null or ${table.maxUses} >= 1`),
  ],
);

export const emailInvite = pgTable(
  'email_invite',
  {
    id: uuid('id').primaryKey(),
    inviteId: uuid('invite_id')
      .notNull()
      .references(() => invite.id, { onDelete: 'cascade' }),
    communityId: uuid('community_id')
      .notNull()
      .references(() => community.id, { onDelete: 'cascade' }),
    recipientEmail: text('recipient_email').notNull(),
    communityName: text('community_name').notNull(),
    inviterUserId: text('inviter_user_id').notNull(),
    inviterUsername: text('inviter_username').notNull(),
    status: text('status').notNull().default('queued'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('email_invite_status_allowed', sql`${table.status} in ('queued','emitted')`)],
);

export const auditLogEntry = pgTable(
  'audit_log_entry',
  {
    id: uuid('id').primaryKey(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => community.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').notNull(),
    action: text('action').notNull(),
    target: text('target').notNull(),
    reason: text('reason'),
    changes: jsonb('changes')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_community_created_idx').on(table.communityId, table.createdAt),
    index('audit_log_community_action_idx').on(table.communityId, table.action),
    index('audit_log_community_actor_idx').on(table.communityId, table.actorUserId),
    index('audit_log_community_target_idx').on(table.communityId, table.target),
  ],
);

export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: uuid('id').primaryKey(),
    topic: text('topic').notNull(),
    eventType: text('event_type').notNull(),
    partitionKey: text('partition_key').notNull(),
    payload: jsonb('payload').notNull(),
    traceParent: text('trace_parent'),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    index('outbox_event_status_created_idx').on(table.status, table.createdAt),
    index('outbox_event_partition_created_idx').on(table.partitionKey, table.createdAt, table.id),
    check('outbox_event_topic_allowed', sql`${table.topic} in ('community_events','community_invite_events')`),
    check('outbox_event_status_allowed', sql`${table.status} in ('pending','published')`),
  ],
);
