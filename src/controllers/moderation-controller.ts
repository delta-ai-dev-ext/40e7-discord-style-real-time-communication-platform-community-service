import {
  banBodySchema,
  communityParamsSchema,
  cursorQuerySchema,
  kickBodySchema,
  memberParamsSchema,
  optionalReasonQuerySchema,
  parseOrThrow,
  timeoutBodySchema,
} from '../models/requests.ts';
import { requireUser, traceParentFrom } from './http.ts';
import type { AppDeps, ControllerResult, RequestData } from './types.ts';

/** Moderation: timeout, clear timeout, kick, ban list/create, unban. */
export function createModerationController(deps: AppDeps) {
  return {
    async timeout(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(timeoutBodySchema, req.body ?? {}, 'body');
      const membership = await deps.services.moderation.timeout({
        actor,
        communityId: params.community_id,
        userId: body.user_id,
        durationSeconds: body.duration_seconds,
        reason: body.reason,
        memberMessage: body.member_message,
        traceParent: traceParentFrom(req),
      });
      return { status: 200, body: membership };
    },

    async clearTimeout(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(memberParamsSchema, req.params, 'path parameters');
      const query = parseOrThrow(optionalReasonQuerySchema, req.query, 'query parameters');
      await deps.services.moderation.clearTimeout({
        actor,
        communityId: params.community_id,
        userId: params.user_id,
        reason: query.reason,
        traceParent: traceParentFrom(req),
      });
      return { status: 204 };
    },

    async kick(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(kickBodySchema, req.body ?? {}, 'body');
      await deps.services.moderation.kick({
        actor,
        communityId: params.community_id,
        userId: body.user_id,
        reason: body.reason,
        memberMessage: body.member_message,
        traceParent: traceParentFrom(req),
      });
      return { status: 204 };
    },

    async listBans(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const query = parseOrThrow(cursorQuerySchema, req.query, 'query parameters');
      const page = await deps.services.moderation.listBans({
        actor,
        communityId: params.community_id,
        cursor: query.cursor,
        limit: query.limit,
      });
      return { status: 200, body: page };
    },

    async ban(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(banBodySchema, req.body ?? {}, 'body');
      const ban = await deps.services.moderation.ban({
        actor,
        communityId: params.community_id,
        userId: body.user_id,
        reason: body.reason,
        memberMessage: body.member_message,
        expiresAt: body.expires_at ? new Date(body.expires_at) : null,
        traceParent: traceParentFrom(req),
      });
      return { status: 201, body: ban };
    },

    async unban(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(memberParamsSchema, req.params, 'path parameters');
      const query = parseOrThrow(optionalReasonQuerySchema, req.query, 'query parameters');
      await deps.services.moderation.unban({
        actor,
        communityId: params.community_id,
        userId: params.user_id,
        reason: query.reason,
        traceParent: traceParentFrom(req),
      });
      return { status: 204 };
    },
  };
}
