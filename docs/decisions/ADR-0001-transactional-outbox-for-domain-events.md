# ADR-0001: Publish domain events through a transactional outbox

## Status
Accepted

## Date
2025-01-01

## Context
`community_service` mutates PostgreSQL state (memberships, roles, overwrites, moderation actions, invites) and must notify three consumers — `realtime_gateway` (live UI + access refresh + moderation notices), `voice_service` (live moderation enforcement), and `chat_service` (history purge) — via the `community_events` and `community_invite_events` Kafka topics.

The state change and its event must never diverge:
- A `member_banned` event that fails to publish leaves the member active in live voice rooms and gateway subscriptions.
- A committed state change with no event leaves gateways showing stale member lists and stale permissions.

Kafka does not participate in PostgreSQL transactions, so a naive "commit, then produce" approach has a failure window (process crash between commit and produce). A "produce, then commit" approach publishes events for changes that may roll back. Neither preserves atomicity.

Additional constraints from the global architecture:
- Producers with database state publish through a transactional outbox (`SYSTEM_DESIGN.md` §5).
- Per-entity ordering: `community_events` uses `community_id` as the partition key.
- Consumers are idempotent by `event_id`.
- The service runs as stateless container replicas with `replicas > 1`, so the relay must tolerate concurrent replicas.

## Decision
Every state change that has a corresponding domain event inserts the event into an `outbox_event` table **inside the same database transaction** as the change. A background relay in each pod polls pending rows, publishes them to Kafka in `(partition_key, created_at, id)` order, and marks them `published`. Delivery is at-least-once; downstream consumers dedupe by `event_id`. `community_outbox_lag_seconds` (age of the oldest pending row) is monitored against the publish-lag SLO (p95 < 2 s).

Ordering guarantee: because the partition key is `community_id` and rows are drained in per-community order, consumers observe a community's events in commit order.

## Alternatives Considered

### Inline Kafka produce inside the request path (after commit)
- Pros: simplest code path; no extra table; lowest publish latency.
- Cons: process crash between commit and produce loses the event silently; no retry record; violates the platform's outbox mandate. Event loss here breaks live moderation enforcement (voice) and access refresh (gateway), which are security-relevant.
- Rejected: unacceptable divergence risk for authorization-adjacent events.

### Kafka transactions / exactly-once semantics
- Pros: exactly-once produce semantics offered by the broker.
- Cons: Kafka transactions cannot be combined with PostgreSQL transactions; they only span Kafka operations, so the dual-write problem remains. Exactly-once also raises latency and operational complexity for a producer that is not read-process-write critical.
- Rejected: does not solve the actual atomicity problem.

### Change-data-capture (logical decoding of WAL into events)
- Pros: zero dual-write by construction; events derived from the committed WAL.
- Cons: requires a CDC connector/infrastructure outside the service's portable runtime (PostgreSQL + Kafka only); couples event schemas to table shapes; harder to attach per-event metadata (member-facing explanations, trace parents) that is not naturally a column.
- Rejected: operational footprint does not fit the portable, stateless-pod model.

### Debezium-style external relay process
- Pros: same outbox table, relay moved out of the pods.
- Cons: adds a stateful component to run and monitor; the MVP favors relays embedded in the stateless service pods.
- Rejected for MVP; revisit if relay load becomes significant (the relay is stateless and can be extracted without changing the outbox contract).

## Consequences
- State changes commit even while Kafka is unavailable; events queue in the outbox and publish on recovery. Alerts fire on outbox lag, not on failed user requests.
- At-least-once delivery means duplicate publishes are possible (e.g., two pods racing on the same pending row); consumers MUST dedupe by `event_id` (already mandated platform-wide).
- Every write path must remember to insert outbox rows in-transaction; repositories and the audit writer make this a single-transaction composition enforced in code review and tests.
- The `outbox_event` table grows with traffic; published rows are eligible for pruning (retention job) since consumers dedupe and late consumers re-read only recent history.
- Internal access endpoints are unaffected: they are synchronous reads and never depend on event publication.