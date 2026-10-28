/**
 * Invite state machine (docs/architecture.md §3.3).
 *
 * Precedence: revoked → expired → exhausted, evaluated against the database row
 * and the transaction clock (never a cached client-side value).
 */
export type InviteState = 'valid' | 'revoked' | 'expired' | 'exhausted';

export interface InviteStateInput {
  revoked: boolean;
  expiresAt: Date | null;
  maxUses: number | null;
  usedCount: number;
}

export function evaluateInviteState(invite: InviteStateInput, now: Date): InviteState {
  if (invite.revoked) return 'revoked';
  if (invite.expiresAt !== null && invite.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) return 'exhausted';
  return 'valid';
}

/** Number of accepts still available, or `Infinity` when unlimited. */
export function remainingUses(invite: InviteStateInput): number {
  if (invite.maxUses === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, invite.maxUses - invite.usedCount);
}
