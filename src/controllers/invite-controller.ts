import {
  communityInviteParamsSchema,
  communityParamsSchema,
  createEmailInviteBodySchema,
  createInviteBodySchema,
  inviteParamsSchema,
  parseOrThrow,
} from '../models/requests.ts';
import { requireUser, traceParentFrom } from './http.ts';
import type { AppDeps, ControllerResult, RequestData } from './types.ts';

/** Invites: link invites, email invites, preview and idempotent accept. */
export function createInviteController(deps: AppDeps) {
  return {
    async create(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(createInviteBodySchema, req.body ?? {}, 'body');
      const invite = await deps.services.invite.createLink({
        actor,
        communityId: params.community_id,
        expiresInSeconds: body.expires_in_seconds,
        maxUses: body.max_uses,
        traceParent: traceParentFrom(req),
      });
      return { status: 201, body: invite };
    },

    async list(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const invites = await deps.services.invite.list({ actor, communityId: params.community_id });
      return { status: 200, body: { invites } };
    },

    async revoke(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityInviteParamsSchema, req.params, 'path parameters');
      await deps.services.invite.revoke({
        actor,
        communityId: params.community_id,
        code: params.code,
        traceParent: traceParentFrom(req),
      });
      return { status: 204 };
    },

    async createEmail(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(createEmailInviteBodySchema, req.body ?? {}, 'body');
      const accepted = await deps.services.invite.createEmailInvite({
        actor,
        communityId: params.community_id,
        email: body.email,
        expiresInSeconds: body.expires_in_seconds,
        traceParent: traceParentFrom(req),
      });
      return { status: 202, body: accepted };
    },

    async preview(req: RequestData): Promise<ControllerResult> {
      await requireUser(deps, req);
      const params = parseOrThrow(inviteParamsSchema, req.params, 'path parameters');
      const preview = await deps.services.invite.preview({ code: params.code });
      return { status: 200, body: preview };
    },

    async accept(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(inviteParamsSchema, req.params, 'path parameters');
      const result = await deps.services.invite.accept({
        actor,
        code: params.code,
        traceParent: traceParentFrom(req),
      });
      return { status: result.created ? 201 : 200, body: result.membership };
    },
  };
}
