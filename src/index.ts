import type { Elysia } from 'elysia';
import { createClerkVerifier } from './auth/clerk.ts';
import { createInternalTokenVerifier } from './auth/internal-token.ts';
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { AppDeps } from './controllers/types.ts';
import { createKafkaProducer } from './events/producer.ts';
import { OutboxRelay } from './events/relay.ts';
import { createInFlightTracker, gracefulShutdown, installSignalHandlers } from './lifecycle.ts';
import { createLogger } from './logger.ts';
import { createMetrics } from './metrics.ts';
import { createDatabase } from './repositories/postgres/database.ts';
import { AccessService } from './services/access-service.ts';
import { AuditService } from './services/audit-service.ts';
import { ChannelService } from './services/channel-service.ts';
import { CommunityService } from './services/community-service.ts';
import type { ServiceDeps } from './services/context.ts';
import { systemClock } from './services/context.ts';
import { InviteService } from './services/invite-service.ts';
import { MemberService } from './services/member-service.ts';
import { ModerationService } from './services/moderation-service.ts';
import { OverwriteService } from './services/overwrite-service.ts';
import { RoleService } from './services/role-service.ts';

export { createApp } from './app.ts';
export type { AppDeps, AppServices } from './controllers/types.ts';

/**
 * Process entrypoint: validate config (fail fast), wire PostgreSQL/Kafka, start
 * HTTP + outbox relay, and install the graceful-shutdown sequence.
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    const issues = error instanceof ConfigError ? error.issues : [String(error)];
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        service_name: 'community_service',
        operation: 'config_load',
        message: 'Invalid configuration',
        issues,
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: config.logLevel });
  const metrics = createMetrics();

  const database = createDatabase({ connectionString: config.databaseUrl });
  const publisher = createKafkaProducer(config.kafka, logger);

  await publisher.connect();
  const databaseReady = await database.ping();
  if (!databaseReady) {
    logger.error('startup.database_unavailable', { operation: 'startup' });
  }

  let ready = databaseReady;
  let shuttingDown = false;

  const serviceDeps: ServiceDeps = {
    repos: database.repositories,
    withTransaction: database.withTransaction,
    clock: systemClock,
    metrics,
    logger,
    inviteUrlBase: config.inviteUrlBase,
  };

  const deps: AppDeps = {
    services: {
      community: new CommunityService(serviceDeps),
      channel: new ChannelService(serviceDeps),
      role: new RoleService(serviceDeps),
      overwrite: new OverwriteService(serviceDeps),
      member: new MemberService(serviceDeps),
      invite: new InviteService(serviceDeps),
      moderation: new ModerationService(serviceDeps),
      audit: new AuditService(serviceDeps),
      access: new AccessService(serviceDeps),
    },
    userAuth: createClerkVerifier({ jwksUrl: config.clerk.jwksUrl, issuer: config.clerk.issuer }),
    internalAuth: createInternalTokenVerifier(config.internalServiceTokens),
    logger,
    metrics,
    readiness: async () => {
      if (shuttingDown) return { ready: false, reason: 'shutting_down' };
      if (!ready) return { ready: false, reason: 'dependencies_unavailable' };
      const healthy = await database.ping();
      if (!healthy) return { ready: false, reason: 'database_unavailable' };
      if (!publisher.isConnected()) return { ready: false, reason: 'kafka_unavailable' };
      return { ready: true };
    },
  };

  const inFlight = createInFlightTracker();
  const app = createApp(deps, { inFlight });
  app.listen(config.port);
  logger.info('server.started', { operation: 'startup', port: config.port });

  const relay = new OutboxRelay({
    repositories: database.repositories,
    publisher,
    logger,
    metrics,
    clock: systemClock,
    batchSize: config.outbox.batchSize,
    pollIntervalMs: config.outbox.pollIntervalMs,
    maxBackoffMs: config.outbox.maxBackoffMs,
  });
  relay.start();

  const shutdown = async () => {
    shuttingDown = true;
    await gracefulShutdown({
      logger,
      timeoutMs: config.shutdownTimeoutMs,
      markNotReady: () => {
        ready = false;
      },
      stopIntake: async () => {
        await app.stop();
      },
      pauseRelay: () => relay.pause(),
      inFlight,
      closeResources: async () => {
        await relay.stop();
        await publisher.disconnect();
        await database.close();
      },
      exit: (code) => process.exit(code),
    });
  };

  installSignalHandlers(shutdown);
}

/** Exported for tests: the Elysia app type of this service. */
export type CommunityServiceApp = Elysia;

if (import.meta.main) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        service_name: 'community_service',
        operation: 'startup',
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exit(1);
  });
}
