import type { Elysia } from 'elysia';
import type { AppDeps } from '../controllers/types.ts';
import { createAuditController, createInternalController } from '../controllers/audit-controller.ts';
import { createChannelController } from '../controllers/channel-controller.ts';
import { createCommunityController } from '../controllers/community-controller.ts';
import { createInviteController } from '../controllers/invite-controller.ts';
import { createMemberController } from '../controllers/member-controller.ts';
import { createModerationController } from '../controllers/moderation-controller.ts';
import { createRoleController } from '../controllers/role-controller.ts';
import type { RequestData } from '../controllers/types.ts';
import { toElysiaHandler } from './helpers.ts';

/**
 * Route table — path-for-path with docs/openapi_spec.yaml.
 *
 * Public API: `/v1/*` (Clerk session JWT).
 * Internal API: `/internal/v1/*` (service bearer token).
 * Probes: `/healthz`, `/readyz`; metrics: `/metrics`.
 */
export function registerRoutes(app: Elysia, deps: AppDeps): void {
  const community = createCommunityController(deps);
  const channel = createChannelController(deps);
  const role = createRoleController(deps);
  const member = createMemberController(deps);
  const invite = createInviteController(deps);
  const moderation = createModerationController(deps);
  const audit = createAuditController(deps);
  const internal = createInternalController(deps);

  const register = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    handler: (req: RequestData) => Promise<{ status: number; body?: unknown }>,
  ) => {
    const descriptor = { method: method.toUpperCase(), path };
    const wrapped = toElysiaHandler(descriptor, handler, deps);
    switch (method) {
      case 'get':
        app.get(path, wrapped);
        break;
      case 'post':
        app.post(path, wrapped);
        break;
      case 'patch':
        app.patch(path, wrapped);
        break;
      case 'put':
        app.put(path, wrapped);
        break;
      case 'delete':
        app.delete(path, wrapped);
        break;
    }
  };

  // -- probes -------------------------------------------------------------------
  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/readyz', async (context) => {
    const snapshot = await deps.readiness();
    if (snapshot.ready) return { status: 'ok' };
    context.set.status = 503;
    return { status: 'unavailable' };
  });
  app.get('/metrics', async () => {
    const body = await deps.metrics.registry.metrics();
    return new Response(body, {
      status: 200,
      headers: { 'content-type': deps.metrics.registry.contentType },
    });
  });

  // -- communities --------------------------------------------------------------
  register('post', '/v1/communities', community.create);
  register('get', '/v1/me/communities', community.listMine);
  register('get', '/v1/communities/:community_id', community.get);
  register('patch', '/v1/communities/:community_id', community.rename);
  register('delete', '/v1/communities/:community_id', community.remove);

  // -- channels & overwrites ----------------------------------------------------
  register('post', '/v1/communities/:community_id/channels', channel.create);
  register('patch', '/v1/communities/:community_id/channels/:channel_id', channel.update);
  register('delete', '/v1/communities/:community_id/channels/:channel_id', channel.remove);
  register(
    'put',
    '/v1/communities/:community_id/channels/:channel_id/permission-overwrites/:target_type/:target_id',
    channel.upsertOverwrite,
  );
  register(
    'delete',
    '/v1/communities/:community_id/channels/:channel_id/permission-overwrites/:target_type/:target_id',
    channel.removeOverwrite,
  );

  // -- roles --------------------------------------------------------------------
  register('get', '/v1/communities/:community_id/roles', role.list);
  register('post', '/v1/communities/:community_id/roles', role.create);
  register('patch', '/v1/communities/:community_id/roles/:role_id', role.update);
  register('delete', '/v1/communities/:community_id/roles/:role_id', role.remove);

  // -- members ------------------------------------------------------------------
  register('get', '/v1/communities/:community_id/members', member.list);
  register('patch', '/v1/communities/:community_id/members/me', member.updateNickname);
  register('delete', '/v1/communities/:community_id/members/me', member.leave);
  register('put', '/v1/communities/:community_id/members/:user_id/roles/:role_id', member.assignRole);
  register('delete', '/v1/communities/:community_id/members/:user_id/roles/:role_id', member.removeRole);

  // -- invites ------------------------------------------------------------------
  register('post', '/v1/communities/:community_id/invites', invite.create);
  register('get', '/v1/communities/:community_id/invites', invite.list);
  register('delete', '/v1/communities/:community_id/invites/:code', invite.revoke);
  register('post', '/v1/communities/:community_id/email-invites', invite.createEmail);
  register('get', '/v1/invites/:code', invite.preview);
  register('post', '/v1/invites/:code/accept', invite.accept);

  // -- moderation ---------------------------------------------------------------
  register('post', '/v1/communities/:community_id/moderation/timeouts', moderation.timeout);
  register('delete', '/v1/communities/:community_id/moderation/timeouts/:user_id', moderation.clearTimeout);
  register('post', '/v1/communities/:community_id/moderation/kicks', moderation.kick);
  register('get', '/v1/communities/:community_id/moderation/bans', moderation.listBans);
  register('post', '/v1/communities/:community_id/moderation/bans', moderation.ban);
  register('delete', '/v1/communities/:community_id/moderation/bans/:user_id', moderation.unban);

  // -- audit log ----------------------------------------------------------------
  register('get', '/v1/communities/:community_id/audit-log', audit.list);

  // -- internal access decisions ------------------------------------------------
  register('get', '/internal/v1/channels/:channel_id/access/:user_id', internal.channelAccess);
  register('get', '/internal/v1/communities/:community_id/members/:user_id/access', internal.memberAccess);
}
