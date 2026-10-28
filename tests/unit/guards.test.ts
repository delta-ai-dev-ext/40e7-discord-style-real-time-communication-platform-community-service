import { describe, expect, test } from 'bun:test';
import { AppError, type ErrorCode } from '../../src/errors.ts';
import type { Permission } from '../../src/models/permissions.ts';
import {
  assertCanGrantPermissions,
  assertCanManageRolePosition,
  assertOwner,
  assertPermission,
  assertRoleAssignable,
  assertTargetOutranked,
  isPrivileged,
  resolveHighestRolePosition,
  type ActorCapability,
} from '../../src/services/guards.ts';

function actor(overrides: Partial<ActorCapability> = {}): ActorCapability {
  return {
    userId: 'actor',
    isOwner: false,
    highestRolePosition: 10,
    permissions: new Set<Permission>(['VIEW_CHANNEL', 'MANAGE_ROLES']),
    ...overrides,
  };
}

function expectAppError(fn: () => void, code: ErrorCode, status: number): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    expect(appError.status).toBe(status);
    return appError;
  }
  throw new Error(`expected AppError ${code}`);
}

describe('hierarchy guards — role positions', () => {
  const cases: {
    name: string;
    actorPosition: number;
    targetPosition: number;
    isOwner: boolean;
    allowed: boolean;
  }[] = [
    { name: 'below the actor', actorPosition: 10, targetPosition: 9, isOwner: false, allowed: true },
    { name: 'equal to the actor', actorPosition: 10, targetPosition: 10, isOwner: false, allowed: false },
    { name: 'above the actor', actorPosition: 10, targetPosition: 11, isOwner: false, allowed: false },
    { name: '@everyone position 0 by a roleless actor', actorPosition: -1, targetPosition: 0, isOwner: false, allowed: false },
    { name: 'any position for the owner', actorPosition: 10, targetPosition: 999, isOwner: true, allowed: true },
  ];

  for (const testCase of cases) {
    test(`role at ${testCase.name} is ${testCase.allowed ? 'manageable' : 'protected'}`, () => {
      const capability = actor({
        isOwner: testCase.isOwner,
        highestRolePosition: testCase.isOwner ? Number.POSITIVE_INFINITY : testCase.actorPosition,
      });
      if (testCase.allowed) {
        expect(() => assertCanManageRolePosition(capability, testCase.targetPosition)).not.toThrow();
      } else {
        expectAppError(
          () => assertCanManageRolePosition(capability, testCase.targetPosition),
          'hierarchy_violation',
          403,
        );
      }
    });
  }

  test('resolveHighestRolePosition returns Infinity for the owner and -1 without roles', () => {
    expect(resolveHighestRolePosition({ isOwner: true, roleIds: [], roles: [] })).toBe(Number.POSITIVE_INFINITY);
    expect(resolveHighestRolePosition({ isOwner: false, roleIds: [], roles: [] })).toBe(-1);
    expect(
      resolveHighestRolePosition({
        isOwner: false,
        roleIds: ['a', 'b'],
        roles: [
          { id: 'a', position: 3 },
          { id: 'b', position: 7 },
          { id: 'c', position: 99 },
        ],
      }),
    ).toBe(7);
  });
});

describe('hierarchy guards — moderation targets', () => {
  test('the owner is untouchable even for an administrator', () => {
    const admin = actor({ permissions: new Set<Permission>(['ADMINISTRATOR']), highestRolePosition: 100 });
    expectAppError(
      () => assertTargetOutranked(admin, { userId: 'owner', isOwner: true, highestRolePosition: 0 }),
      'owner_protected',
      403,
    );
  });

  test('an equal-or-higher target is protected', () => {
    expectAppError(
      () => assertTargetOutranked(actor(), { userId: 'peer', isOwner: false, highestRolePosition: 10 }),
      'hierarchy_violation',
      403,
    );
  });

  test('a lower target is allowed', () => {
    expect(() =>
      assertTargetOutranked(actor(), { userId: 'junior', isOwner: false, highestRolePosition: 3 }),
    ).not.toThrow();
  });

  test('the owner may act on anyone', () => {
    const owner = actor({ isOwner: true, highestRolePosition: Number.POSITIVE_INFINITY });
    expect(() =>
      assertTargetOutranked(owner, { userId: 'x', isOwner: false, highestRolePosition: 999 }),
    ).not.toThrow();
  });
});

describe('guards — permissions and self-grant', () => {
  test('missing permission is a 403 missing_permission', () => {
    expectAppError(() => assertPermission(actor(), 'BAN_MEMBERS'), 'missing_permission', 403);
  });

  test('held permission passes', () => {
    expect(() => assertPermission(actor(), 'MANAGE_ROLES')).not.toThrow();
  });

  test('owner-only guard', () => {
    expectAppError(() => assertOwner(actor()), 'owner_only', 403);
    expect(() => assertOwner(actor({ isOwner: true }))).not.toThrow();
  });

  test('a non-privileged actor cannot grant a permission they do not hold', () => {
    expectAppError(
      () => assertCanGrantPermissions(actor(), ['BAN_MEMBERS']),
      'cannot_grant_unheld_permission',
      403,
    );
  });

  test('granting held permissions is allowed', () => {
    expect(() => assertCanGrantPermissions(actor(), ['VIEW_CHANNEL'])).not.toThrow();
  });

  test('the owner and administrators may grant anything', () => {
    expect(() => assertCanGrantPermissions(actor({ isOwner: true }), ['BAN_MEMBERS'])).not.toThrow();
    expect(() =>
      assertCanGrantPermissions(actor({ permissions: new Set<Permission>(['ADMINISTRATOR']) }), [
        'BAN_MEMBERS',
      ]),
    ).not.toThrow();
  });

  test('unknown permission strings are ignored by the self-grant check', () => {
    expect(() => assertCanGrantPermissions(actor(), ['NOT_REAL'])).not.toThrow();
  });

  test('isPrivileged detects owner and ADMINISTRATOR', () => {
    expect(isPrivileged(actor())).toBe(false);
    expect(isPrivileged(actor({ isOwner: true }))).toBe(true);
    expect(isPrivileged(actor({ permissions: new Set<Permission>(['ADMINISTRATOR']) }))).toBe(true);
  });
});

describe('guards — role assignment', () => {
  test('@everyone cannot be assigned', () => {
    expectAppError(
      () =>
        assertRoleAssignable({
          actor: actor(),
          role: { position: 0, isEveryone: true, permissions: [] },
        }),
      'protected_role',
      403,
    );
  });

  test('a role above the actor is protected', () => {
    expectAppError(
      () =>
        assertRoleAssignable({
          actor: actor(),
          role: { position: 20, isEveryone: false, permissions: [] },
        }),
      'hierarchy_violation',
      403,
    );
  });

  test('assigning a role with unheld permissions is rejected', () => {
    expectAppError(
      () =>
        assertRoleAssignable({
          actor: actor(),
          role: { position: 5, isEveryone: false, permissions: ['BAN_MEMBERS'] },
        }),
      'cannot_grant_unheld_permission',
      403,
    );
  });

  test('assigning a lower role with held permissions is allowed', () => {
    expect(() =>
      assertRoleAssignable({
        actor: actor(),
        role: { position: 5, isEveryone: false, permissions: ['VIEW_CHANNEL'] },
      }),
    ).not.toThrow();
  });
});
