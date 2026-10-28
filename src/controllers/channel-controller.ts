import {
  channelParamsSchema,
  communityParamsSchema,
  createChannelBodySchema,
  overwriteParamsSchema,
  parseOrThrow,
  permissionOverwriteBodySchema,
  updateChannelBodySchema,
} from '../models/requests.ts';
import { requireUser, traceParentFrom } from './http.ts';
import type { AppDeps, ControllerResult, RequestData } from './types.ts';

/** Channels and per-channel permission overwrites. */
export function createChannelController(deps: AppDeps) {
  return {
    async create(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(communityParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(createChannelBodySchema, req.body ?? {}, 'body');
      const channel = await deps.services.channel.create({
        actor,
        communityId: params.community_id,
        name: body.name,
        type: body.type,
        position: body.position,
        traceParent: traceParentFrom(req),
      });
      return { status: 201, body: channel };
    },

    async update(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(channelParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(updateChannelBodySchema, req.body ?? {}, 'body');
      const channel = await deps.services.channel.update({
        actor,
        communityId: params.community_id,
        channelId: params.channel_id,
        name: body.name,
        position: body.position,
        traceParent: traceParentFrom(req),
      });
      return { status: 200, body: channel };
    },

    async remove(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(channelParamsSchema, req.params, 'path parameters');
      await deps.services.channel.remove({
        actor,
        communityId: params.community_id,
        channelId: params.channel_id,
        traceParent: traceParentFrom(req),
      });
      return { status: 204 };
    },

    async upsertOverwrite(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(overwriteParamsSchema, req.params, 'path parameters');
      const body = parseOrThrow(permissionOverwriteBodySchema, req.body ?? {}, 'body');
      const overwrite = await deps.services.overwrite.upsert({
        actor,
        communityId: params.community_id,
        channelId: params.channel_id,
        targetType: params.target_type,
        targetId: params.target_id,
        allow: body.allow,
        deny: body.deny,
        traceParent: traceParentFrom(req),
      });
      return { status: 200, body: overwrite };
    },

    async removeOverwrite(req: RequestData): Promise<ControllerResult> {
      const actor = await requireUser(deps, req);
      const params = parseOrThrow(overwriteParamsSchema, req.params, 'path parameters');
      await deps.services.overwrite.remove({
        actor,
        communityId: params.community_id,
        channelId: params.channel_id,
        targetType: params.target_type,
        targetId: params.target_id,
        traceParent: traceParentFrom(req),
      });
      return { status: 204 };
    },
  };
}
