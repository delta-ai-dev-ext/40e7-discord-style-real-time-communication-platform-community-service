import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * Migrations are generated from the typed schema in `src/repositories/schema.ts`
 * (PostgreSQL schema per docs/architecture.md §5) and applied by CI/CD before
 * the pods roll. Generation never needs a live database; only `migrate` does.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/repositories/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/community_service',
  },
});
