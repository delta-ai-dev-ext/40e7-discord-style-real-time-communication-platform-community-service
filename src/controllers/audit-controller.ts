import {
  auditQuerySchema,
  channelAccessParamsSchema,
  communityParamsSchema,
  memberParamsSchema,
  parseOrThrow,
} from '../models/requests.ts';
import type { AuditAction } from '../models/domain.ts';
import { requireInternalService, requireUser } from './http.ts';
import type { AppDeps, ControllerResult, RequestData } from './types.ts';

/** Audit log reads (public) and the internal access decisions (peer services). */
export function createAuditController(deps: AppDeps) {
  return {
    async list(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const query = parseOrThrow(auditQuerySchema, req.query, 'query parameters');
      const page = await deps.services.audit.list({
        actor,
        communityId: params.community_id,
        action: query.action as AuditAction | undefined,
        actorId: query.actor_id,
        targetId: query.target_id,
        cursor: query.cursor,
        limit: query.limit,
      });
      return { status: 200, body: page };
    },
  };
}

/**
 * Internal access endpoints (`/internal/v1/*`): service bearer token first,
 * then a read-only permission resolution. Timed as a hot path.
 */
export function createInternalController(deps: AppDeps) {
  return {
    async channelAccess(req: RequestData): Promise<ControllerResult> {
      await requireInternalService(deps, req);
      const params = parseOrThrow(channelAccessParamsSchema, req.params, 'path parameters');
      const stop = deps.metrics.accessCheckDuration.startTimer({ endpoint: 'channel_access' });
      try {
        const access = await deps.services.access.channelAccess({
          channelId: params.channel_id,
          userId: params.user_id,
        });
        return { status: 200, body: access };
      } finally {
        stop();
      }
    },

    async memberAccess(req: RequestData): Promise<ControllerResult> {
      await requireInternalService(deps, req);
      const params = parseOrThrow(memberParamsSchema, req.params, 'path parameters');
      const stop = deps.metrics.accessCheckDuration.startTimer({ endpoint: 'member_access' });
      try {
        const access = await deps.services.access.memberAccess({
          communityId: params.community_id,
          userId: params.user_id,
        });
        return { status: 200, body: access };
      } finally {
        stop();
      }
    },
  };
}
