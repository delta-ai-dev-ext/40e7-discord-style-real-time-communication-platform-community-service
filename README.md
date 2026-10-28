# community_service

Authoritative owner of **communities, channels, roles & permissions, memberships, invites,
moderation and the audit log**, and the access-decision source for peer services (`chat_service`,
`voice_service`, `realtime_gateway`). TypeScript on **Bun**, PostgreSQL for state, Kafka
(producer-only) for domain events.

Specifications (source of truth):

| Document | Content |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | responsibilities, permission model, invite state machine, event contracts, PostgreSQL schema §5, observability §7 |
| [`docs/openapi_spec.yaml`](docs/openapi_spec.yaml) | HTTP contract (paths, statuses, schemas) |
| [`docs/user_stories.md`](docs/user_stories.md) | behavioural acceptance criteria (US-001…US-020) |
| [`docs/engineering_guide.md`](docs/engineering_guide.md) | runtime, libraries, layout, configuration, testing rules |
| [`docs/decisions/ADR-0001-transactional-outbox-for-domain-events.md`](docs/decisions/ADR-0001-transactional-outbox-for-domain-events.md) | why every event is written through the outbox |

---

## Quick start

```bash
make install          # bun install --frozen-lockfile
make test             # bun test --coverage (unit + integration, in-process, no infra needed)
make typecheck        # strict tsc --noEmit
make dev              # bun run --watch src/index.ts
make db-generate      # regenerate drizzle-kit SQL migrations from the typed schema
```

`make run` executes the built bundle (`bun run --smol ./dist/index.js`).

Process entrypoint: `src/index.ts` (`createApp()` factory + `main()` bootstrap + signal handling).

## Configuration

12-factor, validated by Zod in `src/config.ts` **before the port is bound** — invalid configuration
exits non-zero with a structured error. No `.env` is read in production.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `KAFKA_BROKERS` | **yes** | — | comma-separated broker list |
| `CLERK_JWKS_URL` | **yes** | — | Clerk published JWKS (offline JWT verification) |
| `CLERK_ISSUER` | **yes** | — | expected `iss` claim |
| `INTERNAL_SERVICE_TOKENS` | **yes** | — | comma-separated per-caller secrets for `/internal/v1/*` |
| `PORT` | no | `3000` | HTTP listen port |
| `KAFKA_CLIENT_ID` | no | `community_service` | Kafka client id |
| `KAFKA_SASL_MECHANISM` / `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` | no | — | SASL (`plain`, `scram-sha-256`, `scram-sha-512`); all three or none |
| `KAFKA_TLS_ENABLED` | no | `false` | TLS to brokers |
| `LOG_LEVEL` | no | `info` | `debug\|info\|warn\|error` |
| `SHUTDOWN_TIMEOUT_MS` | no | `20000` | graceful drain budget |
| `OUTBOX_POLL_INTERVAL_MS` | no | `1000` | relay poll interval |
| `OUTBOX_BATCH_SIZE` | no | `100` | relay batch size |
| `OUTBOX_MAX_BACKOFF_MS` | no | `30000` | relay retry ceiling |
| `INVITE_URL_BASE` | no | `https://app.example.com/invite` | base URL used to render shareable invite links |

## HTTP surface

* Public API — prefix `/v1`, `Authorization: Bearer <clerk session JWT>` verified **offline**
  (signature, `exp`/`nbf`, `iss`) against the cached JWKS. Claims used: `sub`, `username`, `email`.
* Internal API — prefix `/internal/v1`, `Authorization: Bearer <service token>` compared in constant
  time over SHA-256 digests.
* Probes — `GET /healthz` (liveness, never fails on dependency hiccups), `GET /readyz`
  (readiness: pool + producer + not shutting down; `503` otherwise), `GET /metrics` (Prometheus).

Errors always use the single contract:

```json
{ "error": { "code": "missing_permission", "message": "…", "details": { } } }
```

Codes: `validation_error` (400/422), `unauthorized`/`invalid_token` (401), `not_found` (404),
`invite_invalid` (404), `missing_permission`, `not_a_member`, `owner_only`, `owner_protected`,
`hierarchy_violation`, `cannot_grant_unheld_permission`, `protected_role`, `banned`,
`member_timed_out`, `owner_cannot_leave` (403), `invite_expired`/`invite_exhausted`/`invite_revoked`
(410), `internal_error` (500).

## Permission model

Pure engine in `src/services/permission-engine.ts`, applied identically by public routes and the
internal access endpoints (resolution order, most specific last):

1. base role permissions — union of the member's roles plus the implicit `@everyone` role;
   **owner and `ADMINISTRATOR` hold every permission unconditionally**;
2. channel `@everyone` overwrite;
3. the member's role overwrites on that channel;
4. the member's individual overwrite on that channel.

Guards in `src/services/guards.ts`: an actor may never create/modify/delete/assign a role at or
above their own highest position, never targets the owner, and (unless owner/`ADMINISTRATOR`) can
never grant a permission they do not hold themselves — whether through a role, a role assignment or
an allow-overwrite.

## Events (transactional outbox)

Every mutation writes its `outbox_event` row **in the same transaction** as the state change and its
audit entry (ADR-0001). `src/events/relay.ts` drains pending rows in `(partition_key, created_at, id)`
order — giving per-community ordering — publishes to Kafka, marks rows `published`, and retries with
exponential backoff. Delivery is at-least-once; consumers dedupe by `event_id`.

* `community_events` (key `community_id`): `community_updated`, `community_deleted`,
  `channel_created|updated|deleted`, `member_joined|left`, `member_roles_changed`, `roles_changed`,
  `permission_overwrites_changed`, `member_timed_out`, `member_timeout_cleared`, `member_kicked`,
  `member_banned`, `member_unbanned`.
* `community_invite_events` (key `community_id`): `invite_email_requested`.

Envelope: `{event_id, event_type, occurred_at, producer: "community_service", version, trace_parent, data}`.
The inbound W3C `traceparent` is reused verbatim, so a request, its transaction, its audit entry and
its published event are correlated end to end.

## Database

Schema exactly as `docs/architecture.md` §5, defined with drizzle-orm in
`src/repositories/schema.ts`; SQL migrations live in `drizzle/` and are generated by
`make db-generate`. Concurrency relies on unique constraints (idempotent membership insert, one ban
per user, one `@everyone` role, invite code, overwrite target) plus a conditional `used_count`
increment, so no invite can be over-accepted and a duplicate join returns the existing membership.

## Observability

* winston JSON logs to stdout, always carrying `service_name` and (per request) `trace_id`.
* prom-client metrics: `http_request_duration_seconds{route,method,status_class}`,
  `community_access_check_duration_seconds{endpoint}`, `community_outbox_lag_seconds`,
  `kafka_produce_errors_total{topic}`, `community_created_total`,
  `community_invites_created_total{kind}`, `community_invite_accepts_total{result}`,
  `community_members_joined_total`, `community_moderation_actions_total{action}`,
  `community_audit_log_views_total`. No high-cardinality labels.
* Graceful shutdown on `SIGTERM`/`SIGINT`: `/readyz` → `503`, stop accepting connections, pause the
  relay, drain in-flight requests within `SHUTDOWN_TIMEOUT_MS`, close the pool and producer, exit `0`.

## Layout

```
src/
  index.ts        app factory + bootstrap + signal handling
  config.ts       Zod-validated env config (fail fast)
  app.ts          Elysia assembly, error mapping, probes, /metrics
  routes/         one router per resource; transport adapter + metrics
  controllers/    thin handlers: validate → call service → map result
  services/       permission engine, guards, invites, moderation, audit writer
  repositories/   repository contracts, drizzle schema, PostgreSQL adapter
  events/         event schemas, outbox writer, Kafka producer, relay
  models/         permissions, domain rows, request schemas, response DTOs
tests/
  unit/           pure logic: engine, guards, invite state machine, JWT, relay, lifecycle…
  integration/    route → service → repository in-process with in-memory fakes
  mocks/          in-memory repositories + harness/fixtures
```

## Testing

```bash
make test        # bun test --coverage
```

* `bun:test` only; no network or real infrastructure — the integration suite runs the real Elysia
  app, services and permission engine against `tests/mocks/in-memory-repositories.ts`, which mirrors
  PostgreSQL semantics (unique constraints, FK cascades, transactional rollback).
* Fixed clocks make expiry logic (`28`-day timeout cap, invite expiry, ban expiry) deterministic.
* Coverage thresholds (≥ 80 % line/function/statement) are enforced by `bunfig.toml`; the only
  excluded files are the process entrypoint (`src/index.ts`) and the pg/drizzle driver adapter
  (`src/repositories/postgres/**`), which require a live database.

## Container

`Dockerfile` is a three-stage `oven/bun:1` build: production dependencies with
`bun install --frozen-lockfile --production`, a type-checked `bun build` bundle, and a
`oven/bun:1-slim` runtime that runs as the unprivileged `bun` user with `bun run --smol`.
Images are built by CI — never from this repository's agent runtime.
