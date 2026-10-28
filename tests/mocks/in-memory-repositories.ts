import type { ChannelRow, CommunityRow, RoleRow } from '../../src/models/domain.ts';
import { decodeCursor, normalizeLimit, paginate } from '../../src/models/pagination.ts';
import type {
  AuditLogFilters,
  PageQuery,
  Repositories,
  TransactionRunner,
} from '../../src/repositories/types.ts';
import {
  cascadeCommunity,
  cloneState,
  createEmptyState,
  memberRoleKey,
  membershipKey,
  overwriteKey,
  restoreState,
  sortByDate,
  type InMemoryState,
} from './in-memory-state.ts';

/**
 * In-memory implementation of every repository contract (see `in-memory-state.ts`).
 *
 * It mirrors the PostgreSQL semantics the services rely on: unique constraints,
 * FK cascades, conditional `used_count` increments and keyset pagination.
 * `withTransaction` snapshots the state and restores it on failure, so
 * "state change + audit + outbox commit atomically" is testable without a DB.
 */
export type { InMemoryState } from './in-memory-state.ts';

export function pageRows<T extends { id: string }>(
  rows: T[],
  query: PageQuery | undefined,
  sortDate: (row: T) => Date,
  direction: 'asc' | 'desc',
): { items: T[]; nextCursor: string | null } {
  const limit = normalizeLimit(query?.limit);
  const cursor = decodeCursor(query?.cursor);
  const filtered = rows.filter((row) => {
    if (!cursor) return true;
    const rowTime = sortDate(row).getTime();
    const cursorTime = cursor.createdAt.getTime();
    if (rowTime !== cursorTime) {
      return direction === 'asc' ? rowTime > cursorTime : rowTime < cursorTime;
    }
    return direction === 'asc' ? row.id > cursor.id : row.id < cursor.id;
  });
  return paginate(filtered.slice(0, limit + 1), limit, sortDate);
}

export interface InMemoryStore {
  state: InMemoryState;
  repositories: Repositories;
  withTransaction: TransactionRunner;
  transactionCount: { committed: number; rolledBack: number };
}

export function createInMemoryStore(): InMemoryStore {
  const state = createEmptyState();
  const transactionCount = { committed: 0, rolledBack: 0 };

  const baseRepositories: Pick<
    Repositories,
    'community' | 'channel' | 'role' | 'membership' | 'memberRole'
  > = {
    community: {
      async insert(row) {
        state.communities.set(row.id, { ...row });
        return { ...row };
      },
      async findById(id) {
        const found = state.communities.get(id);
        return found ? { ...found } : null;
      },
      async updateName(id, name, updatedAt) {
        const found = state.communities.get(id);
        if (!found) return null;
        const updated = { ...found, name, updatedAt };
        state.communities.set(id, updated);
        return { ...updated };
      },
      async deleteById(id) {
        if (!state.communities.has(id)) return false;
        cascadeCommunity(state, id);
        state.communities.delete(id);
        return true;
      },
      async listByMember(userId) {
        const memberships = sortByDate(
          [...state.memberships.values()].filter((membership) => membership.userId === userId),
          (membership) => membership.joinedAt,
          'asc',
          (membership) => membership.id,
        );
        return memberships
          .map((membership) => state.communities.get(membership.communityId))
          .filter((community): community is CommunityRow => community !== undefined)
          .map((community) => ({ ...community }));
      },
    },

    channel: {
      async insert(row) {
        state.channels.set(row.id, { ...row });
        return { ...row };
      },
      async findById(id) {
        const found = state.channels.get(id);
        return found ? { ...found } : null;
      },
      async listByCommunity(communityId) {
        return [...state.channels.values()]
          .filter((channel) => channel.communityId === communityId)
          .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
          .map((channel) => ({ ...channel }));
      },
      async listIdsByCommunity(communityId) {
        return [...state.channels.values()]
          .filter((channel) => channel.communityId === communityId)
          .map((channel) => channel.id);
      },
      async update(id, patch) {
        const found = state.channels.get(id);
        if (!found) return null;
        const updated: ChannelRow = {
          ...found,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.position !== undefined ? { position: patch.position } : {}),
          updatedAt: patch.updatedAt,
        };
        state.channels.set(id, updated);
        return { ...updated };
      },
      async deleteById(id) {
        if (!state.channels.has(id)) return false;
        for (const [key, overwrite] of [...state.overwrites]) {
          if (overwrite.channelId === id) state.overwrites.delete(key);
        }
        state.channels.delete(id);
        return true;
      },
    },

    role: {
      async insert(row) {
        if (
          row.isEveryone &&
          [...state.roles.values()].some(
            (role) => role.communityId === row.communityId && role.isEveryone,
          )
        ) {
          throw new Error('duplicate @everyone role');
        }
        state.roles.set(row.id, { ...row, permissions: [...row.permissions] });
        return { ...row };
      },
      async findById(id) {
        const found = state.roles.get(id);
        return found ? { ...found, permissions: [...found.permissions] } : null;
      },
      async listByCommunity(communityId) {
        return [...state.roles.values()]
          .filter((role) => role.communityId === communityId)
          .sort((a, b) => b.position - a.position || a.id.localeCompare(b.id))
          .map((role) => ({ ...role, permissions: [...role.permissions] }));
      },
      async findEveryone(communityId) {
        const found = [...state.roles.values()].find(
          (role) => role.communityId === communityId && role.isEveryone,
        );
        return found ? { ...found, permissions: [...found.permissions] } : null;
      },
      async update(id, patch) {
        const found = state.roles.get(id);
        if (!found) return null;
        const updated: RoleRow = {
          ...found,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.permissions !== undefined ? { permissions: [...patch.permissions] } : {}),
          ...(patch.position !== undefined ? { position: patch.position } : {}),
          updatedAt: patch.updatedAt,
        };
        state.roles.set(id, updated);
        return { ...updated, permissions: [...updated.permissions] };
      },
      async deleteById(id) {
        if (!state.roles.has(id)) return false;
        for (const [key, assignment] of [...state.memberRoles]) {
          if (assignment.roleId === id) state.memberRoles.delete(key);
        }
        for (const [key, overwrite] of [...state.overwrites]) {
          if (overwrite.targetType === 'role' && overwrite.targetId === id) {
            state.overwrites.delete(key);
          }
        }
        state.roles.delete(id);
        return true;
      },
    },

    membership: {
      async insert(row) {
        const key = membershipKey(row.communityId, row.userId);
        if (state.memberships.has(key)) return null;
        state.memberships.set(key, { ...row });
        return { ...row };
      },
      async find(communityId, userId) {
        const found = state.memberships.get(membershipKey(communityId, userId));
        return found ? { ...found } : null;
      },
      async listByCommunity(communityId, query) {
        const rows = sortByDate(
          [...state.memberships.values()].filter(
            (membership) => membership.communityId === communityId,
          ),
          (membership) => membership.joinedAt,
          'asc',
          (membership) => membership.id,
        );
        const page = pageRows(rows, query, (row) => row.joinedAt, 'asc');
        return { items: page.items.map((row) => ({ ...row })), nextCursor: page.nextCursor };
      },
      async listByUser(userId) {
        return [...state.memberships.values()]
          .filter((membership) => membership.userId === userId)
          .map((membership) => ({ ...membership }));
      },
      async updateNickname(communityId, userId, nickname) {
        const key = membershipKey(communityId, userId);
        const found = state.memberships.get(key);
        if (!found) return null;
        const updated = { ...found, nickname };
        state.memberships.set(key, updated);
        return { ...updated };
      },
      async setTimedOutUntil(communityId, userId, timedOutUntil) {
        const key = membershipKey(communityId, userId);
        const found = state.memberships.get(key);
        if (!found) return null;
        const updated = { ...found, timedOutUntil };
        state.memberships.set(key, updated);
        return { ...updated };
      },
      async delete(communityId, userId) {
        return state.memberships.delete(membershipKey(communityId, userId));
      },
      async countByCommunity(communityId) {
        return [...state.memberships.values()].filter(
          (membership) => membership.communityId === communityId,
        ).length;
      },
    },

    memberRole: {
      async assign(row) {
        const key = memberRoleKey(row.communityId, row.userId, row.roleId);
        if (state.memberRoles.has(key)) return;
        state.memberRoles.set(key, { ...row });
      },
      async remove(communityId, userId, roleId) {
        return state.memberRoles.delete(memberRoleKey(communityId, userId, roleId));
      },
      async listForMember(communityId, userId) {
        return [...state.memberRoles.values()]
          .filter(
            (assignment) => assignment.communityId === communityId && assignment.userId === userId,
          )
          .map((assignment) => ({ ...assignment }));
      },
      async listByCommunity(communityId) {
        return [...state.memberRoles.values()]
          .filter((assignment) => assignment.communityId === communityId)
          .map((assignment) => ({ ...assignment }));
      },
      async deleteForMember(communityId, userId) {
        let removed = 0;
        for (const [key, assignment] of [...state.memberRoles]) {
          if (assignment.communityId === communityId && assignment.userId === userId) {
            state.memberRoles.delete(key);
            removed += 1;
          }
        }
        return removed;
      },
    },
  };

  const repositories: Repositories = attachRemaining(baseRepositories, state);

  const withTransaction: TransactionRunner = async (fn) => {
    const snapshot = cloneState(state);
    try {
      const result = await fn(repositories);
      transactionCount.committed += 1;
      return result;
    } catch (error) {
      restoreState(state, snapshot);
      transactionCount.rolledBack += 1;
      throw error;
    }
  };

  return { state, repositories, withTransaction, transactionCount };
}

export { overwriteKey };

/** Overwrite, ban, invite, email-invite, audit and outbox repositories. */
type CoreRepositories = Pick<
  Repositories,
  'community' | 'channel' | 'role' | 'membership' | 'memberRole'
>;

function attachRemaining(base: CoreRepositories, state: InMemoryState): Repositories {
  const overwrite: Repositories['overwrite'] = {
    async upsert(row) {
      const key = overwriteKey(row.channelId, row.targetType, row.targetId);
      const existing = state.overwrites.get(key);
      const stored = {
        ...row,
        id: existing?.id ?? row.id,
        createdAt: existing?.createdAt ?? row.createdAt,
      };
      state.overwrites.set(key, stored);
      return { ...stored };
    },
    async find(channelId, targetType, targetId) {
      const found = state.overwrites.get(overwriteKey(channelId, targetType, targetId));
      return found ? { ...found } : null;
    },
    async listByChannel(channelId) {
      return [...state.overwrites.values()]
        .filter((overwrite) => overwrite.channelId === channelId)
        .map((overwrite) => ({ ...overwrite }));
    },
    async listByCommunity(communityId) {
      const channelIds = new Set(
        [...state.channels.values()]
          .filter((channel) => channel.communityId === communityId)
          .map((channel) => channel.id),
      );
      return [...state.overwrites.values()]
        .filter((overwrite) => channelIds.has(overwrite.channelId))
        .map((overwrite) => ({ ...overwrite }));
    },
    async delete(channelId, targetType, targetId) {
      return state.overwrites.delete(overwriteKey(channelId, targetType, targetId));
    },
  };

  const ban: Repositories['ban'] = {
    async upsert(row) {
      state.bans.set(membershipKey(row.communityId, row.userId), { ...row });
      return { ...row };
    },
    async find(communityId, userId) {
      const found = state.bans.get(membershipKey(communityId, userId));
      return found ? { ...found } : null;
    },
    async findActive(communityId, userId, now) {
      const found = state.bans.get(membershipKey(communityId, userId));
      if (!found) return null;
      if (found.expiresAt !== null && found.expiresAt.getTime() <= now.getTime()) return null;
      return { ...found };
    },
    async listByCommunity(communityId, query) {
      const rows = sortByDate(
        [...state.bans.values()].filter((ban) => ban.communityId === communityId),
        (ban) => ban.createdAt,
        'desc',
        (ban) => ban.id,
      );
      const page = pageRows(rows, query, (row) => row.createdAt, 'desc');
      return { items: page.items.map((row) => ({ ...row })), nextCursor: page.nextCursor };
    },
    async delete(communityId, userId) {
      return state.bans.delete(membershipKey(communityId, userId));
    },
  };

  const invite: Repositories['invite'] = {
    async insert(row) {
      if ([...state.invites.values()].some((invite) => invite.code === row.code)) {
        throw new Error('duplicate invite code');
      }
      state.invites.set(row.id, { ...row });
      return { ...row };
    },
    async findByCode(code) {
      const found = [...state.invites.values()].find((invite) => invite.code === code);
      return found ? { ...found } : null;
    },
    async findById(id) {
      const found = state.invites.get(id);
      return found ? { ...found } : null;
    },
    async listActiveByCommunity(communityId) {
      return sortByDate(
        [...state.invites.values()].filter(
          (invite) => invite.communityId === communityId && !invite.revoked,
        ),
        (invite) => invite.createdAt,
        'desc',
        (invite) => invite.id,
      ).map((invite) => ({ ...invite }));
    },
    async revoke(communityId, code) {
      const found = [...state.invites.values()].find(
        (invite) => invite.communityId === communityId && invite.code === code,
      );
      if (!found) return null;
      const updated = { ...found, revoked: true };
      state.invites.set(updated.id, updated);
      return { ...updated };
    },
    async incrementUsedCount(id, maxUses) {
      const found = state.invites.get(id);
      if (!found || found.revoked) return false;
      if (maxUses !== null && found.usedCount >= maxUses) return false;
      state.invites.set(id, { ...found, usedCount: found.usedCount + 1 });
      return true;
    },
  };

  const emailInvite: Repositories['emailInvite'] = {
    async insert(row) {
      state.emailInvites.set(row.id, { ...row });
      return { ...row };
    },
    async findByInviteId(inviteId) {
      const found = [...state.emailInvites.values()].find((entry) => entry.inviteId === inviteId);
      return found ? { ...found } : null;
    },
  };

  const auditLog: Repositories['auditLog'] = {
    async insert(row) {
      state.auditLog.push({ ...row });
      return { ...row };
    },
    async list(communityId: string, filters: AuditLogFilters = {}) {
      const rows = sortByDate(
        state.auditLog.filter((entry) => {
          if (entry.communityId !== communityId) return false;
          if (filters.action && entry.action !== filters.action) return false;
          if (filters.actorUserId && entry.actorUserId !== filters.actorUserId) return false;
          if (filters.target && entry.target !== filters.target) return false;
          return true;
        }),
        (entry) => entry.createdAt,
        'desc',
        (entry) => entry.id,
      );
      const page = pageRows(
        rows,
        { cursor: filters.cursor, limit: filters.limit },
        (row) => row.createdAt,
        'desc',
      );
      return { items: page.items.map((row) => ({ ...row })), nextCursor: page.nextCursor };
    },
  };

  const outbox: Repositories['outbox'] = {
    async insert(row) {
      state.outbox.set(row.id, { ...row });
      return { ...row };
    },
    async listPending(limit) {
      return [...state.outbox.values()]
        .filter((row) => row.status === 'pending')
        .sort(
          (a, b) =>
            a.partitionKey.localeCompare(b.partitionKey) ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    async markPublished(ids, publishedAt) {
      let updated = 0;
      for (const id of ids) {
        const found = state.outbox.get(id);
        if (!found || found.status === 'published') continue;
        state.outbox.set(id, { ...found, status: 'published', publishedAt });
        updated += 1;
      }
      return updated;
    },
    async oldestPendingCreatedAt() {
      const pending = [...state.outbox.values()].filter((row) => row.status === 'pending');
      if (pending.length === 0) return null;
      return pending.reduce(
        (oldest, row) => (row.createdAt.getTime() < oldest.getTime() ? row.createdAt : oldest),
        pending[0]!.createdAt,
      );
    },
  };

  return { ...base, overwrite, ban, invite, emailInvite, auditLog, outbox };
}
