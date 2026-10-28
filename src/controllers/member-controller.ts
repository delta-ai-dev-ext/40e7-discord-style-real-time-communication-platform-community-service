import {
  communityParamsSchema,
  cursorQuerySchema,
  memberRoleParamsSchema,
  parseOrThrow,
  updateNicknameBodySchema,
} from '../models/requests.ts';
import { requireUser, traceParentFrom } from './http.ts';
import type { AppDeps, ControllerResult, RequestData } from './types.ts';

/** Memberships: list, self nickname, leave, role assign/remove. */
export function createMemberController(deps: AppDeps) {
  return {
    async list(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const query = parseOrThrow(cursorQuerySchema, req.query, 'query parameters');
      const page = await deps.services.member.list({
        actor,
        communityId: params.community_id,
        cursor: query.cursor,
        limit: query.limit,
      });
      return { status: 200, body: page };
    },

    async updateNickname(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(updateNicknameBodySchema, req.body ?? {}, 'body');
      const membership = await deps.services.member.updateNickname({
        actor,
        communityId: params.community_id,
        nickname: body.nickname,
      });
      return { status: 200, body: membership };
    },

    async leave(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      await deps.services.member.leave({
        actor,
        communityId: params.community_id,
        traceParent: traceParentFrom(req),
      });
      return { status: 204 };
    },

    async assignRole(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(memberRoleParamsSchema, req.params, 'path parameters');
      await deps.services.member.assignRole({
        actor,
        communityId: params.community_id,
        userId: params.user_id,
        roleId: params.role_id,
        traceParent: traceParentFrom(req),
      });
      return { status: 204 };
    },

    async removeRole(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(memberRoleParamsSchema, req.params, 'path parameters');
      await deps.services.member.removeRole({
        actor,
        communityId: params.community_id,
        userId: params.user_id,
        roleId: params.role_id,
        traceParent: traceParentFrom(req),
      });
      return { status: 204 };
    },
  };
}
