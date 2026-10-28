import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * prom-client metrics from docs/architecture.md §7 and
 * docs/engineering_guide.md (Observability & Logging Conventions).
 *
 * Label cardinality rule: never `user_id`, `community_id`, `channel_id`,
 * `request_id`, or timestamps.
 */
export interface Metrics {
  registry: Registry;
  httpRequestDuration: Histogram<'route' | 'method' | 'status_class'>;
  accessCheckDuration: Histogram<'endpoint'>;
  outboxLag: Gauge<never>;
  kafkaProduceErrors: Counter<'topic'>;
  communityCreated: Counter<never>;
  invitesCreated: Counter<'kind'>;
  inviteAccepts: Counter<'result'>;
  membersJoined: Counter<never>;
  moderationActions: Counter<'action'>;
  auditLogViews: Counter<never>;
}

export interface MetricsOptions {
  withDefaults?: boolean;
}

export function createMetrics(options: MetricsOptions = {}): Metrics {
  const registry = new Registry();
  if (options.withDefaults !== false) {
    collectDefaultMetrics({ register: registry, prefix: 'community_service_' });
  }

  return {
    registry,
    httpRequestDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['route', 'method', 'status_class'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
      registers: [registry],
    }),
    accessCheckDuration: new Histogram({
      name: 'community_access_check_duration_seconds',
      help: 'Internal access check duration in seconds',
      labelNames: ['endpoint'] as const,
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5],
      registers: [registry],
    }),
    outboxLag: new Gauge({
      name: 'community_outbox_lag_seconds',
      help: 'Age of the oldest pending outbox row in seconds',
      registers: [registry],
    }),
    kafkaProduceErrors: new Counter({
      name: 'kafka_produce_errors_total',
      help: 'Kafka produce failures',
      labelNames: ['topic'] as const,
      registers: [registry],
    }),
    communityCreated: new Counter({
      name: 'community_created_total',
      help: 'Communities created',
      registers: [registry],
    }),
    invitesCreated: new Counter({
      name: 'community_invites_created_total',
      help: 'Invites created by kind',
      labelNames: ['kind'] as const,
      registers: [registry],
    }),
    inviteAccepts: new Counter({
      name: 'community_invite_accepts_total',
      help: 'Invite accept attempts by result',
      labelNames: ['result'] as const,
      registers: [registry],
    }),
    membersJoined: new Counter({
      name: 'community_members_joined_total',
      help: 'Memberships created through invite acceptance',
      registers: [registry],
    }),
    moderationActions: new Counter({
      name: 'community_moderation_actions_total',
      help: 'Moderation actions by kind',
      labelNames: ['action'] as const,
      registers: [registry],
    }),
    auditLogViews: new Counter({
      name: 'community_audit_log_views_total',
      help: 'Audit log queries',
      registers: [registry],
    }),
  };
}

/** Status class label (`2xx`, `4xx`, ...) used by the HTTP histogram. */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}
