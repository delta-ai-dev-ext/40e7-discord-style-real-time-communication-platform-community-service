import {
  communityParamsSchema,
  createCommunityBodySchema,
  parseOrThrow,
  updateCommunityBodySchema,
} from '../models/requests.ts';
import { requireUser, traceParentFrom } from './http.ts';
import type { AppDeps, ControllerResult, RequestData } from './types.ts';

/** Communities: create, sidebar list, detail, rename, delete. */
export function createCommunityController(deps: AppDeps) {
  return {
    async create(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const body = parseOrThrow(createCommunityBodySchema, req.body ?? {}, 'body');
      const detail = await deps.services.community.create({
        actor,
        name: body.name,
        traceParent: traceParentFrom(req),
      });
      return { status: 201, body: detail };
    },

    async listMine(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const communities = await deps.services.community.listMine(actor);
      return { status: 200, body: { communities } };
    },

    async get(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const detail = await deps.services.community.get({ actor, communityId: params.community_id });
      return { status: 200, body: detail };
    },

    async rename(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(updateCommunityBodySchema, req.body ?? {}, 'body');
      const community = await deps.services.community.rename({
        actor,
        communityId: params.community_id,
        name: body.name,
        traceParent: traceParentFrom(req),
      });
      return {
        status: 200,
        body: {
          id: community.id,
          name: community.name,
          owner_user_id: community.ownerUserId,
          created_at: community.createdAt.toISOString(),
        },
      };
    },

    async remove(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      await deps.services.community.remove({
        actor,
        communityId: params.community_id,
        traceParent: traceParentFrom(req),
      });
      return { status: 204 };
    },
  };
}
