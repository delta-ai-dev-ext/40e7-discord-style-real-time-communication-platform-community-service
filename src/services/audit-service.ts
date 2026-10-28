import type { AuthenticatedUser, AuditAction } from '../models/domain.ts';
import type { AuditLogListDto } from '../models/dtos.ts';
import { toAuditLogEntry } from '../models/responses.ts';
import { loadActorState, requireMember } from './authorization.ts';
import type { ServiceDeps } from './context.ts';
import { assertPermission } from './guards.ts';

/** Audit log reads: paginated, newest first, filterable (US-016). */
export class AuditService {
  constructor(private readonly deps: ServiceDeps) {}

  async list(input: {
    actor: AuthenticatedUser;
    communityId: string;
    action?: AuditAction | undefined;
    actorId?: string | undefined;
    targetId?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<AuditLogListDto> {
    const state = await loadActorState({
      repos: this.deps.repos,
      communityId: input.communityId,
      userId: input.actor.userId,
    });
    requireMember(state);
    assertPermission(state.actor, 'VIEW_AUDIT_LOG');

    const page = await this.deps.repos.auditLog.list(input.communityId, {
      action: input.action,
      actorUserId: input.actorId,
      target: input.targetId,
      cursor: input.cursor,
      limit: input.limit,
    });

    this.deps.metrics.auditLogViews.inc();
    return { entries: page.items.map(toAuditLogEntry), next_cursor: page.nextCursor };
  }
}
