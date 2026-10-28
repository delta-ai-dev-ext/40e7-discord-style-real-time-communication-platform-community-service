import {
  communityParamsSchema,
  createRoleBodySchema,
  parseOrThrow,
  roleParamsSchema,
  updateRoleBodySchema,
} from '../models/requests.ts';
import { requireUser, traceParentFrom } from './http.ts';
import type { AppDeps, ControllerResult, RequestData } from './types.ts';

/** Community roles: list, create, update, delete. */
export function createRoleController(deps: AppDeps) {
  return {
    async list(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const roles = await deps.services.role.list({ actor, communityId: params.community_id });
      return { status: 200, body: { roles } };
    },

    async create(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(createRoleBodySchema, req.body ?? {}, 'body');
      const role = await deps.services.role.create({
        actor,
        communityId: params.community_id,
        name: body.name,
        permissions: body.permissions,
        position: body.position,
        traceParent: traceParentFrom(req),
      });
      return { status: 201, body: role };
    },

    async update(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(roleParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(updateRoleBodySchema, req.body ?? {}, 'body');
      const role = await deps.services.role.update({
        actor,
        communityId: params.community_id,
        roleId: params.role_id,
        name: body.name,
        permissions: body.permissions,
        position: body.position,
        traceParent: traceParentFrom(req),
      });
      return { status: 200, body: role };
    },

    async remove(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(roleParamsSchema, req.params, 'path parameters');
      await deps.services.role.remove({
        actor,
        communityId: params.community_id,
        roleId: params.role_id,
        traceParent: traceParentFrom(req),
      });
      return { status: 204 };
    },
  };
}
