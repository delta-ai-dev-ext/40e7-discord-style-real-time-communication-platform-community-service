import winston from 'winston';

/**
 * Structured JSON logging (winston → stdout).
 *
 * Every line carries `service_name`; request-scoped loggers add `trace_id` so an
 * inbound request, its database transaction, its outbox row and the relay's
 * publish can be correlated (docs/engineering_guide.md).
 */
export const SERVICE_NAME = 'community_service';

export interface LogMeta {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** Returns a logger bound to additional fields (e.g. `trace_id`, `operation`). */
  child(bindings: LogMeta): Logger;
}

export interface LoggerOptions {
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Suppresses transport output (used by tests). */
  silent?: boolean;
}

class WinstonLogger implements Logger {
  constructor(
    private readonly logger: winston.Logger,
    private readonly bindings: LogMeta = {},
  ) {}

  debug(message: string, meta?: LogMeta): void {
    this.logger.debug(message, { ...this.bindings, ...meta });
  }

  info(message: string, meta?: LogMeta): void {
    this.logger.info(message, { ...this.bindings, ...meta });
  }

  warn(message: string, meta?: LogMeta): void {
    this.logger.warn(message, { ...this.bindings, ...meta });
  }

  error(message: string, meta?: LogMeta): void {
    this.logger.error(message, { ...this.bindings, ...meta });
  }

  child(bindings: LogMeta): Logger {
    return new WinstonLogger(this.logger, { ...this.bindings, ...bindings });
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const logger = winston.createLogger({
    level: options.level ?? 'info',
    defaultMeta: { service_name: SERVICE_NAME },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
    transports: [new winston.transports.Console({ silent: options.silent ?? false })],
  });
  return new WinstonLogger(logger);
}

/** In-memory logger for unit tests: records every entry without touching stdout. */
export interface RecordedLog {
  level: string;
  message: string;
  meta: LogMeta;
}

export function createTestLogger(sink: RecordedLog[] = []): Logger & { entries: RecordedLog[] } {
  const entries = sink;
  const make = (bindings: LogMeta): Logger & { entries: RecordedLog[] } => ({
    entries,
    debug: (message, meta) => entries.push({ level: 'debug', message, meta: { ...bindings, ...meta } }),
    info: (message, meta) => entries.push({ level: 'info', message, meta: { ...bindings, ...meta } }),
    warn: (message, meta) => entries.push({ level: 'warn', message, meta: { ...bindings, ...meta } }),
    error: (message, meta) => entries.push({ level: 'error', message, meta: { ...bindings, ...meta } }),
    child: (childBindings) => make({ ...bindings, ...childBindings }),
  });
  return make({});
}
