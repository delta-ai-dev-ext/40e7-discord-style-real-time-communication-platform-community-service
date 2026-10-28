import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Repositories, TransactionRunner } from '../types.ts';
import { createPostgresRepositories } from './repositories.ts';

/**
 * PostgreSQL pool + drizzle instance + transaction runner.
 *
 * `withTransaction` is the only way services mutate state: the state change, its
 * audit entry and its outbox row commit atomically (ADR-0001).
 */
export interface Database {
  repositories: Repositories;
  withTransaction: TransactionRunner;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  connectionTimeoutMs?: number;
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5000,
  });
  // An idle client error must never crash the process (readiness reports it).
  pool.on('error', () => undefined);

  const db = drizzle(pool);
  const repositories = createPostgresRepositories(db);

  const withTransaction: TransactionRunner = (fn) =>
    db.transaction(async (tx) => fn(createPostgresRepositories(tx as never)));

  return {
    repositories,
    withTransaction,
    async ping() {
      try {
        await pool.query('select 1');
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await pool.end();
    },
  };
}
