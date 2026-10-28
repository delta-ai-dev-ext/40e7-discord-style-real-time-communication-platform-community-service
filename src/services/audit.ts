import { uuidv4 } from '../ids.ts';
import type { AuditAction, AuditLogEntryRow } from '../models/domain.ts';
import type { Repositories } from '../repositories/types.ts';

/**
 * Audit writer — always called inside the same transaction as the change
 * (docs/architecture.md §5, US-016).
 */
export interface AuditEntryInput {
  communityId: string;
  actorUserId: string;
  action: AuditAction;
  target: string;
  reason?: string | null;
  changes?: Record<string, unknown>;
  occurredAt: Date;
  /** Inject for deterministic tests. */
  id?: string;
}

export async function writeAuditEntry(
  repos: Repositories,
  input: AuditEntryInput,
): Promise<AuditLogEntryRow> {
  return repos.auditLog.insert({
    id: input.id ?? uuidv4(),
    communityId: input.communityId,
    actorUserId: input.actorUserId,
    action: input.action,
    target: input.target,
    reason: input.reason ?? null,
    changes: input.changes ?? {},
    createdAt: input.occurredAt,
  });
}
