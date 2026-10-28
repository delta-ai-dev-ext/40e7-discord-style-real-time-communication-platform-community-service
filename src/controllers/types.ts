import type { ClerkVerifier } from '../auth/clerk.ts';
import type { InternalTokenVerifier } from '../auth/internal-token.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { AccessService } from '../services/access-service.ts';
import type { AuditService } from '../services/audit-service.ts';
import type { ChannelService } from '../services/channel-service.ts';
import type { CommunityService } from '../services/community-service.ts';
import type { InviteService } from '../services/invite-service.ts';
import type { MemberService } from '../services/member-service.ts';
import type { ModerationService } from '../services/moderation-service.ts';
import type { OverwriteService } from '../services/overwrite-service.ts';
import type { RoleService } from '../services/role-service.ts';

/**
 * Controller contract: controllers are thin — validate, call one service, map
 * the result — and never import Elysia except through this transport-neutral
 * request/response pair.
 */
export interface RequestData {
  headers: Record<string, string | undefined>;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
}

export interface ControllerResult {
  status: number;
  body?: unknown;
}

export interface AppServices {
  community: CommunityService;
  channel: ChannelService;
  role: RoleService;
  overwrite: OverwriteService;
  member: MemberService;
  invite: InviteService;
  moderation: ModerationService;
  audit: AuditService;
  access: AccessService;
}

export interface ReadinessSnapshot {
  ready: boolean;
  reason?: string;
}

export interface AppDeps {
  services: AppServices;
  userAuth: ClerkVerifier;
  internalAuth: InternalTokenVerifier;
  logger: Logger;
  metrics: Metrics;
  readiness: () => Promise<ReadinessSnapshot>;
}

/** Reads a single header value case-insensitively. */
export function header(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name.toLowerCase()] ?? headers[name];
  return direct;
}
