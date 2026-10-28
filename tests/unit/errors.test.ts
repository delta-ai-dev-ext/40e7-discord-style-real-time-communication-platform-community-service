import { describe, expect, test } from 'bun:test';
import { AppError, toErrorResponse } from '../../src/errors.ts';

describe('AppError factories', () => {
  const cases: {
    name: string;
    error: AppError;
    code: string;
    status: number;
  }[] = [
    { name: 'validation', error: AppError.validation('bad'), code: 'validation_error', status: 400 },
    { name: 'unprocessable', error: AppError.unprocessable('rule'), code: 'validation_error', status: 422 },
    { name: 'unauthorized', error: AppError.unauthorized(), code: 'unauthorized', status: 401 },
    { name: 'invalidToken', error: AppError.invalidToken(), code: 'invalid_token', status: 401 },
    { name: 'notFound', error: AppError.notFound(), code: 'not_found', status: 404 },
    { name: 'notAMember', error: AppError.notAMember(), code: 'not_a_member', status: 403 },
    {
      name: 'missingPermission',
      error: AppError.missingPermission('BAN_MEMBERS'),
      code: 'missing_permission',
      status: 403,
    },
    { name: 'ownerOnly', error: AppError.ownerOnly(), code: 'owner_only', status: 403 },
    { name: 'ownerProtected', error: AppError.ownerProtected(), code: 'owner_protected', status: 403 },
    { name: 'hierarchy', error: AppError.hierarchy(), code: 'hierarchy_violation', status: 403 },
    {
      name: 'cannotGrant',
      error: AppError.cannotGrant('BAN_MEMBERS'),
      code: 'cannot_grant_unheld_permission',
      status: 403,
    },
    { name: 'protectedRole', error: AppError.protectedRole(), code: 'protected_role', status: 403 },
    { name: 'inviteInvalid', error: AppError.inviteInvalid(), code: 'invite_invalid', status: 404 },
    { name: 'inviteExpired', error: AppError.inviteGone('expired'), code: 'invite_expired', status: 410 },
    { name: 'inviteExhausted', error: AppError.inviteGone('exhausted'), code: 'invite_exhausted', status: 410 },
    { name: 'inviteRevoked', error: AppError.inviteGone('revoked'), code: 'invite_revoked', status: 410 },
    { name: 'banned', error: AppError.banned(), code: 'banned', status: 403 },
    { name: 'timedOut', error: AppError.timedOut(), code: 'member_timed_out', status: 403 },
    { name: 'ownerCannotLeave', error: AppError.ownerCannotLeave(), code: 'owner_cannot_leave', status: 403 },
    { name: 'internal', error: AppError.internal(), code: 'internal_error', status: 500 },
  ];

  for (const testCase of cases) {
    test(`${testCase.name} ⇒ ${testCase.status} ${testCase.code}`, () => {
      expect(testCase.error.code).toBe(testCase.code as never);
      expect(testCase.error.status).toBe(testCase.status);
      expect(testCase.error.message.length).toBeGreaterThan(0);
    });
  }

  test('details are included only when provided', () => {
    expect(AppError.banned().toBody().error.details).toBeUndefined();
    expect(AppError.banned({ member_message: 'later' }).toBody().error.details).toEqual({
      member_message: 'later',
    });
  });

  test('invite gone errors carry a helpful message', () => {
    expect(AppError.inviteGone('expired').message).toMatch(/expired/i);
    expect(AppError.inviteGone('exhausted').message).toMatch(/maximum number of uses/i);
    expect(AppError.inviteGone('revoked').message).toMatch(/revoked/i);
  });
});

describe('toErrorResponse', () => {
  test('maps AppError to its status and contract body', () => {
    const response = toErrorResponse(AppError.missingPermission('KICK_MEMBERS'));
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('missing_permission');
    expect(response.body.error.message).toContain('KICK_MEMBERS');
  });

  test('never leaks internals for unexpected errors', () => {
    const response = toErrorResponse(new Error('connection string leaked'));
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'internal_error', message: 'Unexpected server error' },
    });
  });
});
