import { describe, expect, test } from 'bun:test';
import { evaluateInviteState, remainingUses, type InviteStateInput } from '../../src/services/invite-state.ts';

const now = new Date('2025-02-01T12:00:00.000Z');

function invite(overrides: Partial<InviteStateInput> = {}): InviteStateInput {
  return { revoked: false, expiresAt: null, maxUses: null, usedCount: 0, ...overrides };
}

describe('invite state machine', () => {
  const cases: {
    name: string;
    input: Partial<InviteStateInput>;
    expected: 'valid' | 'revoked' | 'expired' | 'exhausted';
  }[] = [
    { name: 'no expiry and unlimited uses', input: {}, expected: 'valid' },
    { name: 'future expiry', input: { expiresAt: new Date('2025-02-02T00:00:00.000Z') }, expected: 'valid' },
    { name: 'expiry exactly now is expired', input: { expiresAt: now }, expected: 'expired' },
    { name: 'past expiry', input: { expiresAt: new Date('2025-01-01T00:00:00.000Z') }, expected: 'expired' },
    { name: 'max uses not reached', input: { maxUses: 5, usedCount: 4 }, expected: 'valid' },
    { name: 'max uses reached', input: { maxUses: 5, usedCount: 5 }, expected: 'exhausted' },
    { name: 'revoked beats expiry', input: { revoked: true, expiresAt: new Date('2025-01-01T00:00:00.000Z') }, expected: 'revoked' },
    { name: 'revoked beats exhaustion', input: { revoked: true, maxUses: 1, usedCount: 9 }, expected: 'revoked' },
    { name: 'expiry beats exhaustion', input: { expiresAt: new Date('2025-01-01T00:00:00.000Z'), maxUses: 1, usedCount: 9 }, expected: 'expired' },
  ];

  for (const testCase of cases) {
    test(`${testCase.name} ⇒ ${testCase.expected}`, () => {
      expect(evaluateInviteState(invite(testCase.input), now)).toBe(testCase.expected);
    });
  }

  test('remaining uses is Infinity without a cap and floors at zero', () => {
    expect(remainingUses(invite())).toBe(Number.POSITIVE_INFINITY);
    expect(remainingUses(invite({ maxUses: 3, usedCount: 1 }))).toBe(2);
    expect(remainingUses(invite({ maxUses: 3, usedCount: 9 }))).toBe(0);
  });
});
