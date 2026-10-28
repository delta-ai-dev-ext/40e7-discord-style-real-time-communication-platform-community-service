import { describe, expect, test } from 'bun:test';
import { AppError } from '../../src/errors.ts';
import {
  auditQuerySchema,
  banBodySchema,
  channelParamsSchema,
  createEmailInviteBodySchema,
  createInviteBodySchema,
  createRoleBodySchema,
  cursorQuerySchema,
  kickBodySchema,
  overwriteParamsSchema,
  parseOrThrow,
  permissionOverwriteBodySchema,
  timeoutBodySchema,
  updateChannelBodySchema,
  updateNicknameBodySchema,
  updateRoleBodySchema,
} from '../../src/models/requests.ts';

const UUID = '00000000-0000-4000-8000-000000000000';

describe('parseOrThrow', () => {
  test('returns parsed data', () => {
    expect(parseOrThrow(updateNicknameBodySchema, { nickname: 'Ace' }, 'body')).toEqual({
      nickname: 'Ace',
    });
  });

  test('throws a 400 validation_error with issue details', () => {
    try {
      parseOrThrow(updateNicknameBodySchema, { nickname: 42 }, 'body');
      throw new Error('should not reach');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.status).toBe(400);
      expect(appError.code).toBe('validation_error');
      expect(Array.isArray((appError.details as { issues: unknown[] }).issues)).toBe(true);
    }
  });
});

describe('body schemas', () => {
  test('updateChannel requires at least one field', () => {
    expect(updateChannelBodySchema.safeParse({}).success).toBe(false);
    expect(updateChannelBodySchema.safeParse({ position: 2 }).success).toBe(true);
  });

  test('updateRole requires at least one field', () => {
    expect(updateRoleBodySchema.safeParse({}).success).toBe(false);
    expect(updateRoleBodySchema.safeParse({ name: 'x' }).success).toBe(true);
  });

  test('role permissions must come from the fixed vocabulary', () => {
    expect(createRoleBodySchema.safeParse({ name: 'r', permissions: ['VIEW_CHANNEL'], position: 1 }).success).toBe(
      true,
    );
    expect(createRoleBodySchema.safeParse({ name: 'r', permissions: ['NOPE'], position: 1 }).success).toBe(
      false,
    );
  });

  test('overwrite allow/deny default to empty arrays', () => {
    expect(permissionOverwriteBodySchema.parse({})).toEqual({ allow: [], deny: [] });
  });

  test('invite body defaults and bounds', () => {
    expect(createInviteBodySchema.parse(undefined)).toEqual({});
    expect(createInviteBodySchema.safeParse({ expires_in_seconds: 59 }).success).toBe(false);
    expect(createInviteBodySchema.safeParse({ expires_in_seconds: 60 }).success).toBe(true);
    expect(createInviteBodySchema.safeParse({ max_uses: 0 }).success).toBe(false);
    expect(createInviteBodySchema.safeParse({ max_uses: null }).success).toBe(true);
  });

  test('email invite validates the address', () => {
    expect(createEmailInviteBodySchema.safeParse({ email: 'fan@example.com' }).success).toBe(true);
    expect(createEmailInviteBodySchema.safeParse({ email: 'nope' }).success).toBe(false);
    expect(createEmailInviteBodySchema.safeParse({}).success).toBe(false);
  });

  test('timeout enforces the 28-day cap and required reason', () => {
    expect(
      timeoutBodySchema.safeParse({ user_id: 'u', duration_seconds: 2419200, reason: 'r' }).success,
    ).toBe(true);
    expect(
      timeoutBodySchema.safeParse({ user_id: 'u', duration_seconds: 2419201, reason: 'r' }).success,
    ).toBe(false);
    expect(timeoutBodySchema.safeParse({ user_id: 'u', duration_seconds: 60 }).success).toBe(false);
  });

  test('kick and ban bodies', () => {
    expect(kickBodySchema.safeParse({ user_id: 'u', reason: 'r' }).success).toBe(true);
    expect(banBodySchema.safeParse({ user_id: 'u', reason: 'r', expires_at: null }).success).toBe(true);
    expect(banBodySchema.safeParse({ user_id: 'u', reason: 'r', expires_at: 'not-a-date' }).success).toBe(
      false,
    );
  });
});

describe('query and path schemas', () => {
  test('cursor query clamps the limit and coerces strings', () => {
    expect(cursorQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(cursorQuerySchema.parse({ limit: '10' })).toEqual({ limit: 10 });
    expect(cursorQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });

  test('audit query rejects an unknown action', () => {
    expect(auditQuerySchema.safeParse({ action: 'member_banned' }).success).toBe(true);
    expect(auditQuerySchema.safeParse({ action: 'nope' }).success).toBe(false);
  });

  test('path parameter schemas enforce UUIDs and target types', () => {
    expect(channelParamsSchema.safeParse({ community_id: UUID, channel_id: UUID }).success).toBe(true);
    expect(channelParamsSchema.safeParse({ community_id: 'x', channel_id: UUID }).success).toBe(false);
    expect(
      overwriteParamsSchema.safeParse({
        community_id: UUID,
        channel_id: UUID,
        target_type: 'role',
        target_id: 'role-1',
      }).success,
    ).toBe(true);
    expect(
      overwriteParamsSchema.safeParse({
        community_id: UUID,
        channel_id: UUID,
        target_type: 'everyone',
        target_id: 'x',
      }).success,
    ).toBe(false);
  });
});
