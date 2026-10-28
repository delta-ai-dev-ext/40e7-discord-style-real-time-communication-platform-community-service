import type { Elysia } from 'elysia';
import { createApp } from '../../src/app.ts';
import { createInternalTokenVerifier } from '../../src/auth/internal-token.ts';
import type { ClerkVerifier } from '../../src/auth/clerk.ts';
import type { AppDeps, AppServices } from '../../src/controllers/types.ts';
import { AppError } from '../../src/errors.ts';
import { createTestLogger, type RecordedLog } from '../../src/logger.ts';
import { createMetrics, type Metrics } from '../../src/metrics.ts';
import type { AuthenticatedUser } from '../../src/models/domain.ts';
import { AccessService } from '../../src/services/access-service.ts';
import { AuditService } from '../../src/services/audit-service.ts';
import { ChannelService } from '../../src/services/channel-service.ts';
import { CommunityService } from '../../src/services/community-service.ts';
import { fixedClock, type Clock, type ServiceDeps } from '../../src/services/context.ts';
import { InviteService } from '../../src/services/invite-service.ts';
import { MemberService } from '../../src/services/member-service.ts';
import { ModerationService } from '../../src/services/moderation-service.ts';
import { OverwriteService } from '../../src/services/overwrite-service.ts';
import { RoleService } from '../../src/services/role-service.ts';
import { uuidv4 } from '../../src/ids.ts';
import { createInMemoryStore, type InMemoryStore } from './in-memory-repositories.ts';

/**
 * In-process test harness: the real Elysia app, real services and real
 * permission engine, wired to the in-memory repositories with a deterministic
 * clock. Auth is faked at the verifier boundary so tests speak for users.
 */
export const INTERNAL_TOKEN = 'service-token-1';
export const INVITE_URL_BASE = 'https://app.test/invite';

export interface TestHarness {
  app: Elysia;
  deps: AppDeps;
  services: AppServices;
  store: InMemoryStore;
  metrics: Metrics;
  logs: RecordedLog[];
  setNow(at: Date): void;
  now(): Date;
  request(
    method: string,
    path: string,
    options?: {
      as?: string | null;
      token?: string | null;
      internal?: boolean;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<{ status: number; body: any }>;
}

/** Test tokens are `test_<userId>`; the fake verifier maps them to a user. */
export function userForToken(token: string): AuthenticatedUser | null {
  if (!token.startsWith('test_')) return null;
  const userId = token.slice('test_'.length);
  if (!userId) return null;
  return { userId, username: `${userId}#1`, email: `${userId}@example.com` };
}

export function createFakeClerkVerifier(): ClerkVerifier {
  return {
    async verify(token) {
      const user = userForToken(token);
      if (!user) throw AppError.invalidToken();
      return user;
    },
    async authenticate(authorizationHeader) {
      if (!authorizationHeader) throw AppError.unauthorized('Missing session token');
      const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
      if (!match) throw AppError.unauthorized('Missing session token');
      const user = userForToken((match[1] ?? '').trim());
      if (!user) throw AppError.invalidToken();
      return user;
    },
  };
}

export interface HarnessOptions {
  now?: Date;
  ready?: boolean;
}

export function createHarness(options: HarnessOptions = {}): TestHarness {
  const store = createInMemoryStore();
  const metrics = createMetrics({ withDefaults: false });
  const logs: RecordedLog[] = [];
  const logger = createTestLogger(logs);
  let current = new Date((options.now ?? new Date('2025-02-01T12:00:00.000Z')).getTime());
  const clock: Clock = fixedClock(() => current);

  const serviceDeps: ServiceDeps = {
    repos: store.repositories,
    withTransaction: store.withTransaction,
    clock,
    metrics,
    logger,
    inviteUrlBase: INVITE_URL_BASE,
  };

  const services: AppServices = {
    community: new CommunityService(serviceDeps),
    channel: new ChannelService(serviceDeps),
    role: new RoleService(serviceDeps),
    overwrite: new OverwriteService(serviceDeps),
    member: new MemberService(serviceDeps),
    invite: new InviteService(serviceDeps),
    moderation: new ModerationService(serviceDeps),
    audit: new AuditService(serviceDeps),
    access: new AccessService(serviceDeps),
  };

  const deps: AppDeps = {
    services,
    userAuth: createFakeClerkVerifier(),
    internalAuth: createInternalTokenVerifier([INTERNAL_TOKEN]),
    logger,
    metrics,
    readiness: async () => ({ ready: options.ready ?? true }),
  };

  const app = createApp(deps);

  return {
    app,
    deps,
    services,
    store,
    metrics,
    logs,
    setNow(at) {
      current = new Date(at.getTime());
    },
    now() {
      return new Date(current.getTime());
    },
    async request(method, path, requestOptions = {}) {
      const headers: Record<string, string> = { ...(requestOptions.headers ?? {}) };
      if (requestOptions.internal) {
        headers.authorization = `Bearer ${INTERNAL_TOKEN}`;
      } else if (requestOptions.token !== null) {
        const token = requestOptions.token ?? (requestOptions.as ? `test_${requestOptions.as}` : null);
        if (token) headers.authorization = `Bearer ${token}`;
      }
      if (requestOptions.body !== undefined) headers['content-type'] = 'application/json';

      const response = await app.handle(
        new Request(`http://localhost${path}`, {
          method,
          headers,
          ...(requestOptions.body !== undefined
            ? { body: JSON.stringify(requestOptions.body) }
            : {}),
        }),
      );
      const text = await response.text();
      let body: unknown = undefined;
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
      }
      return { status: response.status, body };
    },
  };
}

/** Creates a community through the public API and returns its detail payload. */
export async function createCommunity(
  harness: TestHarness,
  options: { owner?: string; name?: string } = {},
): Promise<{ id: string; owner: string; channels: { id: string; name: string; type: string }[] }> {
  const owner = options.owner ?? 'owner';
  const response = await harness.request('POST', '/v1/communities', {
    as: owner,
    body: { name: options.name ?? 'Test Community' },
  });
  if (response.status !== 201) {
    throw new Error(`community creation failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return {
    id: response.body.id as string,
    owner,
    channels: response.body.channels as { id: string; name: string; type: string }[],
  };
}

/** Adds a member and optional roles directly through the repository layer. */
export async function addMember(
  harness: TestHarness,
  communityId: string,
  userId: string,
  roleIds: string[] = [],
): Promise<void> {
  const now = harness.now();
  await harness.store.repositories.membership.insert({
    id: `membership-${userId}`,
    communityId,
    userId,
    nickname: null,
    timedOutUntil: null,
    joinedAt: now,
  });
  for (const roleId of roleIds) {
    await harness.store.repositories.memberRole.assign({
      communityId,
      userId,
      roleId,
      assignedBy: 'test',
      assignedAt: now,
    });
  }
}

/** Creates a role directly through the repository layer (bypassing guards). */
export async function addRole(
  harness: TestHarness,
  communityId: string,
  options: {
    id?: string;
    name: string;
    position: number;
    permissions?: string[];
    isEveryone?: boolean;
  },
): Promise<string> {
  const now = harness.now();
  // Path parameters are UUID-validated, so generated ids are real UUIDv4s.
  const id = options.id ?? uuidv4();
  await harness.store.repositories.role.insert({
    id,
    communityId,
    name: options.name,
    permissions: (options.permissions ?? []) as never,
    position: options.position,
    isEveryone: options.isEveryone ?? false,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
