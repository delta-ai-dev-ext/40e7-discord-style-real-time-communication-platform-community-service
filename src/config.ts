import { z } from 'zod';

/**
 * 12-factor configuration validated at startup (docs/engineering_guide.md).
 *
 * Required: DATABASE_URL, KAFKA_BROKERS, CLERK_JWKS_URL, CLERK_ISSUER,
 * INTERNAL_SERVICE_TOKENS. Validation fails fast with a structured error.
 */
const BooleanString = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const OptionalString = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  });

const CommaSeparated = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .refine((entries) => entries.length > 0, { message: 'must contain at least one entry' });

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  KAFKA_BROKERS: CommaSeparated,
  KAFKA_CLIENT_ID: z.string().min(1).default('community_service'),
  KAFKA_SASL_MECHANISM: OptionalString,
  KAFKA_SASL_USERNAME: OptionalString,
  KAFKA_SASL_PASSWORD: OptionalString,
  KAFKA_TLS_ENABLED: BooleanString,
  CLERK_JWKS_URL: z.url(),
  CLERK_ISSUER: z.string().min(1, 'CLERK_ISSUER is required'),
  INTERNAL_SERVICE_TOKENS: CommaSeparated,
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(20000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  OUTBOX_MAX_BACKOFF_MS: z.coerce.number().int().min(100).default(30000),
  INVITE_URL_BASE: z.string().min(1).default('https://app.example.com/invite'),
});

export type Env = z.infer<typeof envSchema>;

export interface KafkaSaslConfig {
  mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512';
  username: string;
  password: string;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  kafka: {
    clientId: string;
    brokers: string[];
    tls: boolean;
    sasl?: KafkaSaslConfig;
  };
  clerk: { jwksUrl: string; issuer: string };
  internalServiceTokens: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  shutdownTimeoutMs: number;
  inviteUrlBase: string;
  outbox: { pollIntervalMs: number; batchSize: number; maxBackoffMs: number };
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function resolveSasl(env: Env): KafkaSaslConfig | undefined {
  const { KAFKA_SASL_MECHANISM: mechanism, KAFKA_SASL_USERNAME: username, KAFKA_SASL_PASSWORD: password } = env;
  if (!mechanism && !username && !password) return undefined;
  if (!mechanism || !username || !password) {
    throw new ConfigError([
      'KAFKA_SASL_MECHANISM, KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD must be set together',
    ]);
  }
  const normalized = mechanism.toLowerCase();
  if (normalized !== 'plain' && normalized !== 'scram-sha-256' && normalized !== 'scram-sha-512') {
    throw new ConfigError([`KAFKA_SASL_MECHANISM must be plain|scram-sha-256|scram-sha-512 (got ${mechanism})`]);
  }
  return { mechanism: normalized, username, password };
}

/** Validates raw environment values into the typed application config. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.join('.') || 'environment';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }

  const value = parsed.data;
  const sasl = resolveSasl(value);

  return {
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    kafka: {
      clientId: value.KAFKA_CLIENT_ID,
      brokers: value.KAFKA_BROKERS,
      tls: value.KAFKA_TLS_ENABLED,
      ...(sasl ? { sasl } : {}),
    },
    clerk: { jwksUrl: value.CLERK_JWKS_URL, issuer: value.CLERK_ISSUER },
    internalServiceTokens: value.INTERNAL_SERVICE_TOKENS,
    logLevel: value.LOG_LEVEL,
    shutdownTimeoutMs: value.SHUTDOWN_TIMEOUT_MS,
    inviteUrlBase: value.INVITE_URL_BASE.replace(/\/+$/, ''),
    outbox: {
      pollIntervalMs: value.OUTBOX_POLL_INTERVAL_MS,
      batchSize: value.OUTBOX_BATCH_SIZE,
      maxBackoffMs: value.OUTBOX_MAX_BACKOFF_MS,
    },
  };
}
