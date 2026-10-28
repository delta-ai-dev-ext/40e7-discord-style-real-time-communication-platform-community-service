# community_service — Architecture

Source of truth: `SYSTEM_DESIGN.md` §4.2, §5, §6, §7. This document is the clean service-level architecture and the source of truth for the Diagram Agent. Library, framework, and tooling choices live in `docs/engineering_guide.md`.

---

## 1. Service Responsibilities

`community_service` is the **authoritative owner of community structure and access decisions**:

1. **Communities** — create (creator becomes owner), rename, delete (owner only). Deletion removes all dependent structure.
2. **Channels** — text and voice/video channels with position ordering; create/update/delete gated on `MANAGE_CHANNELS`.
3. **Roles & permissions** — community roles carrying permission sets with a hierarchy position. Implicit `@everyone` role applies to all members; the **owner implicitly holds all permissions**. A moderator can never act on (assign, modify, or target) a role at or above their own highest position.
4. **Per-channel permission overwrites** — allow/deny sets per role or per member, resolved Discord-style (see §3.1).
5. **Memberships** — join via invite, leave, role assignment, nickname.
6. **Invites** — shareable link invites (random code, optional expiry and max uses, revocable) and email invites (creates the invite, emits an event for the notification pipeline).
7. **Moderation** — timeout (≤ 28 days) with clear, kick, ban (optional expiry), unban — each with an internal `reason` and an optional **member-facing explanation** in non-punitive wording.
8. **Audit log** — every moderation action and every role/overwrite/channel/invite administration change is written **in the same transaction** as the change.
9. **Internal access endpoints** — authoritative per-channel and per-community access decisions consumed synchronously by `chat_service`, `voice_service`, and `realtime_gateway`.

**Does NOT own:** user profiles/identities (identity_service mirrors Clerk), message content (chat_service), voice media (LiveKit via voice_service), email delivery (notification_service via the emitted event). Produces events only; has no outbound synchronous dependencies.

---

## 2. Internal Component Boundaries

| Component | Responsibility |
|---|---|
| **HTTP API layer** | Public REST endpoints (Clerk JWT verified offline against Clerk JWKS), internal access endpoints (service bearer token, cluster-network only), probes |
| **Permission resolution engine** | Pure domain logic computing effective permissions for a member on a channel or community; used by both public routes and internal access endpoints |
| **Community/channel/role service** | CRUD plus hierarchy and self-grant enforcement rules |
| **Membership service** | Join/leave/roles/nickname with idempotent invite acceptance and ban checks |
| **Invite service** | Code generation, preview state machine (valid/expired/exhausted/revoked/invalid), accept flow, email invite creation |
| **Moderation service** | Timeout/kick/ban/unban with hierarchy guards and member-facing explanations |
| **Audit writer** | Builds audit entries (actor, action, target, reason, before/after summary) within the same DB transaction as the change |
| **Outbox relay** | Publishes committed `outbox_event` rows to Kafka in per-community order; retries with backoff; exposes outbox lag |
| **Event schema registry** | Versioned event envelopes and payloads for `community_events` and `community_invite_events` |

Layering rule: HTTP handlers → services (business rules) → repositories (persistence). The permission engine is pure and shared.

---

## 3. Synchronous HTTP Flows

### 3.1 Public API flow (any authenticated route)
1. Client sends `Authorization: Bearer <clerk_session_jwt>`.
2. Service verifies the JWT **offline** (Clerk published public key/JWKS). Claims used: `sub` (platform `user_id`), `username`, `email`. No per-request call to Clerk or any other service.
3. Request validated at the boundary; unknown/invalid → `401`.
4. Handler resolves the caller's membership and effective permissions (engine §4).
5. Service executes the domain action; **audit entry written in the same transaction**; outbox row(s) inserted in the same transaction.
6. Response per the OpenAPI error contract `{error: {code, message, details?}}`.

### 3.2 Permission resolution order (Discord-style)
For a member on a channel, effective permissions resolve in this exact order, most specific last:
1. **Base role permissions** — union of all the member's role permissions (owner → all permissions; `ADMINISTRATOR` → all permissions).
2. **Channel `@everyone` overwrite** — applies to everyone; allow/deny adjust the base set.
3. **Role overwrites** — the member's roles' overwrites apply to the channel.
4. **Member overwrite** — the individual member's overwrite on that channel wins last.

Hierarchy and self-grant guards:
- Actors may not create/modify/delete a role at a position ≥ their own highest role position.
- Actors may not assign/remove a role at a position ≥ their own highest position, and never target the owner.
- Moderation actions (timeout/kick/ban) cannot target the owner or a member with an equal-or-higher role.
- Unless the actor is the owner or holds `ADMINISTRATOR`, an actor cannot grant (via overwrites) a permission they do not themselves hold.

### 3.3 Invite state machine (preview & accept)
For code `c`: unknown → `404 invite_invalid`; `revoked` → `410 invite_revoked`; `expires_at ≤ now` → `410 invite_expired`; `max_uses` reached (`used_count ≥ max_uses`) → `410 invite_exhausted`. Successful previews include community name, member count, and inviter username where resolvable, so the UI can guide users to ask for a new link.

**Accept flow:** begin transaction → re-check invite state → check `ban` (active ban → `403 banned` with the ban's member-facing explanation) → insert `membership` (unique `(community_id, user_id)`; a conflict returns the existing membership idempotently, `200`) → increment `invite.used_count` → write audit entry → insert outbox event `member_joined` → commit.

### 3.4 Internal access flows (hot path — p95 < 25 ms, 99.95% availability)
- `GET /internal/v1/channels/{channel_id}/access/{user_id}`: authenticate internal service token → load channel + community → load membership/bans/roles/overwrites → run the resolution engine → return `{community_id, channel_type, is_member, can_view, can_read_history, can_send, can_connect, can_speak, can_video, timed_out_until, banned}`.
- `GET /internal/v1/communities/{community_id}/members/{user_id}/access`: same data, community scope → `{is_member, banned, visible_channel_ids[], timed_out_until}`.

Failure modes: token invalid → `401` (never reach business logic); unknown channel/community → `404`; the caller (`chat_service`/`voice_service`) fails **closed** on errors.

---

## 4. Asynchronous Event Flows (Transactional Outbox)

`community_service` is a **pure Kafka producer**. State changes and events can never diverge because every event is inserted into `outbox_event` inside the same database transaction as the state change, then relayed to Kafka asynchronously (see ADR-0001).

### 4.1 Relay mechanics
- A background relay in each pod queries pending outbox rows ordered by `(community_id, created_at, id)` — the partition key `community_id` guarantees per-community ordering.
- Publish → mark `published`. On Kafka failure: retry with exponential backoff; events are never dropped, and consumers dedupe by `event_id` (at-least-once delivery, exactly-once effect downstream).
- `community_outbox_lag_seconds` gauges the age of the oldest pending row; alerting threshold from the SLO (publish lag p95 < 2 s).

### 4.2 Topic `community_events` (partition key `community_id`)

Consumers: `realtime_gateway` (live UI + access refresh + moderation notices), `voice_service` (live moderation enforcement), `chat_service` (history purge).

| Event type | `data` |
|---|---|
| `community_updated` | `{community_id, name}` |
| `community_deleted` | `{community_id, channel_ids[]}` |
| `channel_created` / `channel_updated` | `{community_id, channel_id, name, type, position}` |
| `channel_deleted` | `{community_id, channel_id, type}` |
| `member_joined` / `member_left` | `{community_id, user_id}` |
| `member_roles_changed` | `{community_id, user_id, role_ids[]}` |
| `roles_changed` | `{community_id, role_id}` |
| `permission_overwrites_changed` | `{community_id, channel_id}` |
| `member_timed_out` | `{community_id, user_id, moderator_user_id, timed_out_until, member_message, voice_channel_ids[]}` |
| `member_timeout_cleared` | `{community_id, user_id, voice_channel_ids[]}` |
| `member_kicked` / `member_banned` | `{community_id, user_id, moderator_user_id, member_message, voice_channel_ids[], ban_expires_at?}` (ban only) |
| `member_unbanned` | `{community_id, user_id}` |

Envelope: `{event_id (uuid), event_type, occurred_at (ISO-8601), producer: "community_service", version, trace_parent, data}`. `trace_parent` is the W3C traceparent of the originating request.

### 4.3 Topic `community_invite_events` (partition key `community_id`)

Consumer: `notification_service`.

| Event type | `data` |
|---|---|
| `invite_email_requested` | `{invite_code, invite_url, community_id, community_name, inviter_user_id, inviter_username, recipient_email, expires_at}` |

Emitted only from `POST /v1/communities/{community_id}/email-invites`; the public endpoint responds `202` without waiting for email delivery.

### 4.4 Event emission map
| Route change | Emitted events |
|---|---|
| Rename community | `community_updated` |
| Delete community | `community_deleted` (+ channel ids) |
| Channel create/update/delete | `channel_created` / `channel_updated` / `channel_deleted` |
| Overwrite set/remove | `permission_overwrites_changed` |
| Role create/update/delete | `roles_changed` |
| Role assign/remove on member | `member_roles_changed` |
| Invite accept / leave / kick / ban | `member_joined` / `member_left` / `member_kicked` / `member_banned` |
| Timeout set/clear | `member_timed_out` / `member_timeout_cleared` |
| Unban | `member_unbanned` |
| Email invite | `invite_email_requested` (on `community_invite_events`) |

---

## 5. PostgreSQL Schema

One logical database owned exclusively by `community_service`. All identifiers are UUIDv4 except `user_id`, which is the Clerk user id (text). All timestamps are `timestamptz`. snake_case table/column names.

### `community`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| name | varchar(100) | NOT NULL, CHECK length ≥ 1 |
| owner_user_id | text | NOT NULL |
| created_at | timestamptz | NOT NULL DEFAULT now() |
| updated_at | timestamptz | NOT NULL DEFAULT now() |

### `channel`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| community_id | uuid | NOT NULL FK → community(id) ON DELETE CASCADE |
| name | varchar(100) | NOT NULL, CHECK length ≥ 1 |
| type | text | NOT NULL CHECK (type IN ('text','voice')) |
| position | integer | NOT NULL DEFAULT 0 |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

Indexes: `(community_id, position)`. Default channels on creation: `#general` (text), `General` (voice).

### `role`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| community_id | uuid | NOT NULL FK → community(id) ON DELETE CASCADE |
| name | varchar(100) | NOT NULL |
| permissions | text[] | NOT NULL DEFAULT '{}'; values from the fixed permission set (VIEW_CHANNEL … ADMINISTRATOR) |
| position | integer | NOT NULL |
| is_everyone | boolean | NOT NULL DEFAULT false; implicit `@everyone` role — not creatable/deletable via API |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

Indexes: `(community_id, position DESC)`; partial unique `(community_id)` WHERE `is_everyone` (exactly one `@everyone` per community).

### `membership`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| community_id | uuid | NOT NULL FK → community(id) ON DELETE CASCADE |
| user_id | text | NOT NULL |
| nickname | text | NULL |
| timed_out_until | timestamptz | NULL; timed out while `timed_out_until > now()` |
| joined_at | timestamptz | NOT NULL DEFAULT now() |

Constraints/indexes: UNIQUE `(community_id, user_id)` (enforces idempotent invite acceptance and single membership per user per community); index `user_id` for "my communities".

### `member_role`
| Column | Type | Constraints |
|---|---|---|
| community_id | uuid | FK → community(id) ON DELETE CASCADE |
| user_id | text | NOT NULL |
| role_id | uuid | FK → role(id) ON DELETE CASCADE |
| assigned_by | text | NOT NULL |
| assigned_at | timestamptz | NOT NULL DEFAULT now() |

PK: `(community_id, user_id, role_id)`.

### `permission_overwrite`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| channel_id | uuid | NOT NULL FK → channel(id) ON DELETE CASCADE |
| target_type | text | NOT NULL CHECK (target_type IN ('role','member')) |
| target_id | uuid | NOT NULL (role id or member's user id) |
| allow | text[] | NOT NULL DEFAULT '{}' |
| deny | text[] | NOT NULL DEFAULT '{}' |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

Constraints/indexes: UNIQUE `(channel_id, target_type, target_id)`; CHECK no permission appears in both `allow` and `deny`.

### `ban`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| community_id | uuid | NOT NULL FK → community(id) ON DELETE CASCADE |
| user_id | text | NOT NULL |
| reason | text | NOT NULL |
| member_message | text | NULL (member-facing explanation) |
| expires_at | timestamptz | NULL (permanent ban when NULL) |
| created_by | text | NOT NULL |
| created_at | timestamptz | NOT NULL DEFAULT now() |

Constraints/indexes: UNIQUE `(community_id, user_id)` (unban deletes the row). **Active ban** := row exists AND (`expires_at IS NULL` OR `expires_at > now()`).

### `invite`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| community_id | uuid | NOT NULL FK → community(id) ON DELETE CASCADE |
| code | varchar(32) | NOT NULL UNIQUE (crypto-random, URL-safe) |
| created_by | text | NOT NULL |
| expires_at | timestamptz | NULL |
| max_uses | integer | NULL (unlimited when NULL); CHECK max_uses ≥ 1 |
| used_count | integer | NOT NULL DEFAULT 0 |
| revoked | boolean | NOT NULL DEFAULT false |
| created_at | timestamptz | NOT NULL DEFAULT now() |

Indexes: `(community_id)` partial WHERE `revoked = false` (active invite listing); lookup by `code` via the unique index.

### `email_invite`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| invite_id | uuid | NOT NULL FK → invite(id) ON DELETE CASCADE |
| community_id | uuid | NOT NULL FK → community(id) ON DELETE CASCADE |
| recipient_email | text | NOT NULL |
| community_name | text | NOT NULL (snapshot for the email event) |
| inviter_user_id | text | NOT NULL |
| inviter_username | text | NOT NULL (snapshot from JWT claim) |
| status | text | NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','emitted')) |
| created_at | timestamptz | NOT NULL DEFAULT now() |

Snapshot columns guarantee the emitted event carries everything the notification pipeline needs without cross-service reads.

### `audit_log_entry`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| community_id | uuid | NOT NULL FK → community(id) ON DELETE CASCADE |
| actor_user_id | text | NOT NULL |
| action | text | NOT NULL (fixed action vocabulary: community_renamed, community_deleted, channel_created/updated/deleted, role_created/updated/deleted, permission_overwrite_set/removed, member_role_assigned/removed, invite_created/revoked, email_invite_created, member_timed_out, member_timeout_cleared, member_kicked, member_banned, member_unbanned) |
| target | text | NOT NULL (target user_id/channel_id/role_id/invite code/community_id) |
| reason | text | NULL |
| changes | jsonb | NOT NULL DEFAULT '{}' (before/after summary) |
| created_at | timestamptz | NOT NULL DEFAULT now() |

Indexes: `(community_id, created_at DESC)` (default audit view); `(community_id, action)`; `(community_id, actor_user_id)`; `(community_id, target)`.

### `outbox_event`
| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK (= event_id in the envelope) |
| topic | text | NOT NULL CHECK (topic IN ('community_events','community_invite_events')) |
| event_type | text | NOT NULL |
| partition_key | text | NOT NULL (community_id) |
| payload | jsonb | NOT NULL (full `data` object) |
| trace_parent | text | NULL (W3C traceparent of the originating request) |
| status | text | NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published')) |
| created_at | timestamptz | NOT NULL DEFAULT now() |
| published_at | timestamptz | NULL |

Indexes: `(status, created_at)` for relay polling; `(partition_key, created_at, id)` for per-community ordered draining.

**Relationships summary:** community 1—N channel, role, membership, invite, audit_log_entry, outbox_event (all cascade). membership 1—N member_role. channel 1—N permission_overwrite. invite 1—1 email_invite. role 1—N member_role, 1—N permission_overwrite (by target).

---

## Stateless Container Operational Model

- **Stateless replicas (`replicas >= 1`)**: all state in PostgreSQL; Kafka is the only async channel. No local mutable state; safe to scale horizontally and reschedule at any time.
- **Graceful shutdown**: on `SIGTERM`/`SIGINT` — (1) `/readyz` starts returning `503`; (2) stop accepting new HTTP requests and pause the outbox relay; (3) drain in-flight requests within a bounded timeout; (4) close the DB pool and Kafka producer; exit `0`.
- **Probes**: `/healthz` liveness (process responsive; must not fail on transient dependency hiccups); `/readyz` readiness (PostgreSQL pool + Kafka producer connected; `503` during shutdown).
- **Concurrency safety with `replicas > 1`**: every mutation is a short transaction with unique constraints as the conflict arbiter (idempotent joins, single active ban, single `@everyone` role). The outbox relay drains per-partition-key ordering; duplicate in-flight publishes across pods are harmless because consumers dedupe by `event_id`.

### Failure modes & resilience
| Failure | Behavior |
|---|---|
| Kafka unavailable | State changes still commit (DB-first); outbox rows accumulate; relay retries with backoff; `community_outbox_lag_seconds` rises and alerts; consumers see events once Kafka recovers |
| Invite accept race (two pods) | Unique `(community_id, user_id)` makes one insert win; loser returns the existing membership (idempotent `200`) |
| Invite used_count race | `used_count` incremented atomically with a conditional update comparing against `max_uses`; over-accept is impossible |
| Moderator action on protected target | Hierarchy/owner guards evaluated in the service layer before write; no partial writes (single transaction with audit entry) |
| Internal access endpoint error | Peer services fail closed (`503` mapping on their side); this service returns structured errors and never "opens" access by default |
| Clock-dependent invite expiry | Evaluated inside the accept/preview transaction (`expires_at ≤ now()`), not cached client-side |

---

## 7. Observability

### Business metrics
| Metric | Type | Labels |
|---|---|---|
| `community_created_total` | counter | — |
| `community_invites_created_total` | counter | `kind=link\|email` |
| `community_invite_accepts_total` | counter | `result=joined\|expired\|invalid\|banned` |
| `community_members_joined_total` | counter | — |
| `community_moderation_actions_total` | counter | `action=timeout\|timeout_clear\|kick\|ban\|unban` |
| `community_audit_log_views_total` | counter | — |

### Technical metrics
| Metric | Type | Labels |
|---|---|---|
| `http_request_duration_seconds` | histogram | `route`, `method`, `status_class` |
| `community_access_check_duration_seconds` | histogram | `endpoint` (internal access routes) |
| `community_outbox_lag_seconds` | gauge | — (age of oldest pending outbox row) |
| `kafka_produce_errors_total` | counter | `topic` |

Label cardinality rule: never `user_id`, `community_id`, `channel_id`, `request_id`, or timestamps.

### SLOs
- Internal access check: p95 < 25 ms, 99.95% availability (hot path of chat and voice).
- Public API: p95 < 200 ms; 99.9% availability.
- Outbox publish lag: p95 < 2 s.

### Tracing
W3C `traceparent` accepted on inbound HTTP, propagated into the event envelope (`trace_parent`), and attached to relay logs so a state change can be correlated with its published event end-to-end.