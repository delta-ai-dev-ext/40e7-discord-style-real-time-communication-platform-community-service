# community_service — User Stories

Source of truth: `SYSTEM_DESIGN.md` §4.2 (communities, channels, roles & permissions, memberships, invites, moderation, audit log, internal access endpoints) and §5 (event contracts). Stories are behavioral requirements; API and schema details live in `docs/openapi_spec.yaml` and `docs/architecture.md`.

All roles below refer to platform users authenticated with a Clerk session JWT, and to permission holders (`owner`, `member with role X`) inside a community.

---

## Communities

## US-001: Create a community

**As a** signed-in user,
**I want to** create a community with a name,
**So that** I can build a space for my creator/fan audience.

### Acceptance Criteria
- Given a signed-in user with a valid name, when they create a community, then the community is created with the creator as **owner**, a default `#general` text channel, a default `General` voice channel, and an implicit `@everyone` role.
- Given a signed-in user, when they create a community whose name exceeds the allowed length or is blank, then the request is rejected with a validation error and no community is created.
- Given the creation succeeds, when the creator later loads the community, then they see the default channels and their own effective permissions as owner.

### Out of Scope
- Community themes, icons, or per-community S3 uploads.

## US-002: Rename or delete a community

**As a** community owner,
**I want to** rename or delete my community,
**So that** I remain in full control of its identity and existence.

### Acceptance Criteria
- Given the owner, when they rename the community, then all members' next community loads reflect the new name and a `community_updated` change reaches live subscribers.
- Given the owner, when they delete the community, then the community, its channels, roles, overwrites, memberships, invites, and audit log become inaccessible and a `community_deleted` event (with channel ids) notifies live subscribers and peer services.
- Given a non-owner (even a member holding `ADMINISTRATOR`), when they attempt to rename or delete the community, then they are rejected with a permission error.

### Out of Scope
- Community export or transfer of ownership (not in the MVP design).

## US-003: Load a community (sidebar bootstrap and detail)

**As a** community member,
**I want to** see the communities I belong to and load a community's visible channels,
**So that** I can navigate and use only what I am permitted to see.

### Acceptance Criteria
- Given a signed-in user, when they request their communities, then they receive every community they are a member of, each with the channels **visible to that caller** under effective permissions.
- Given a member, when they load a community, then they receive the community, its visible channels, and their own **effective permissions** for that community.
- Given a user who is not a member (or whose access was revoked), when they load a community they do not belong to, then they receive a not-found/forbidden response rather than any community data.

### Out of Scope
- Live updates of the sidebar (delivered by `realtime_gateway` via events, not this service).

---

## Channels

## US-004: Manage channels

**As a** member with `MANAGE_CHANNELS`,
**I want to** create, reorder, rename, and delete text and voice channels,
**So that** the community's spaces match how people actually talk.

### Acceptance Criteria
- Given a member with `MANAGE_CHANNELS`, when they create a channel of type `text` or `voice` with an optional position, then the channel appears in listings ordered by its position.
- Given a member with `MANAGE_CHANNELS`, when they update a channel's name or position, then the change is visible to subsequent loads and a `channel_updated` change is emitted.
- Given a member with `MANAGE_CHANNELS`, when they delete a channel, then the channel is removed and a `channel_deleted` change (with channel id and type) is emitted so peer services purge dependent data.
- Given a member without `MANAGE_CHANNELS`, when they attempt any channel management action, then they are rejected with a missing-permission error and an audit entry is **not** written for a denied action.

### Out of Scope
- Channel categories beyond the position ordering (categories exist only as ordering/grouping metadata).

---

## Roles & permissions

## US-005: Manage community roles

**As a** member with `MANAGE_ROLES`,
**I want to** create, update, and delete roles with permission sets and a hierarchy position,
**So that** I can delegate powers safely.

### Acceptance Criteria
- Given a member with `MANAGE_ROLES`, when they create a role with a name, permission set (from the defined permission list), and position, then the role exists and can be assigned.
- Given a member with `MANAGE_ROLES`, when they update or delete a role, then assignments change accordingly and a `roles_changed` change is emitted for live access refresh.
- Given a moderator with `MANAGE_ROLES`, when they attempt to create/modify/delete a role at a position **equal to or higher than their own highest role**, then they are rejected (role-hierarchy protection).
- Given any caller, when they attempt role management on the implicit `@everyone` role or delete the owner, then the action is rejected.

### Out of Scope
- Per-channel role assignment; per-community invite-gated auto-roles.

## US-006: Per-channel permission overwrites

**As a** member with `MANAGE_CHANNELS` (and `MANAGE_ROLES` for role overwrites),
**I want to** set allow/deny permission overwrites per channel for a role or a specific member,
**So that** I can open or lock individual channels without reshaping community-wide roles.

### Acceptance Criteria
- Given an authorized member, when they set overwrites (`allow[]`, `deny[]`) for a target of type `role` or `member` on a channel, then the overwrite is stored and a `permission_overwrites_changed` change is emitted for that channel.
- Given an authorized member, when they delete an overwrite for a target, then that target reverts to base role resolution on that channel.
- Given any caller, when they attempt to set overwrites with permissions they themselves do not hold, then the action is rejected (a moderator cannot grant powers they lack, unless owner/`ADMINISTRATOR`).

### Out of Scope
- Category-level overwrites; overwrite inheritance trees.

## US-007: Effective permission resolution is Discord-style

**As a** member of a community,
**I want to** my access to follow base roles, then channel overwrites, consistently,
**So that** channel behavior is predictable.

### Acceptance Criteria
- Given a member whose roles grant a permission, when the service resolves effective permissions for a channel, then resolution applies, in order: base role permissions → channel `@everyone` overwrite → role overwrites → member overwrite (most specific wins).
- Given the community owner, when permissions are resolved anywhere in the community, then the owner implicitly holds **all** permissions regardless of roles or overwrites.
- Given a member whose `@everyone` base denies a permission that a channel member-overwrite allows, when they access that channel, then the allow takes effect.

### Out of Scope
- Time-boxed permission grants (use roles + moderation actions instead).

---

## Memberships

## US-008: Join a community via invite link

**As a** signed-in user with an invite code,
**I want to** preview and accept an invite,
**So that** I can join the right community with confidence.

### Acceptance Criteria
- Given a valid, active invite code, when a signed-in user previews it, then they receive the community name, member count, inviter username (where known), and expiry.
- Given a valid invite code, when the user accepts, then a membership is created, the invite's used count increments, a `member_joined` change is emitted, and the membership is returned.
- Given the same user who is already a member, when they accept the same invite again, then the call is **idempotent**: the existing membership is returned without a duplicate join or a second `member_joined` event.
- Given an expired, exhausted, or revoked code, when the user previews or accepts, then they receive the specific error code (`invite_expired`, `invite_exhausted`, `invite_revoked`) plus the community name and inviter username where known, so the UI can guide them to ask for a new link.
- Given an unknown code, when the user previews or accepts, then they receive `invite_invalid`.
- Given a **banned** user, when they accept an invite, then they are rejected with `403 banned` including the member-facing explanation attached to their ban.

### Out of Scope
- Joining without any invite in the MVP; invite approvals.

## US-009: Leave, nickname, and role assignment

**As a** community member or role manager,
**I want to** leave communities, set nicknames, and assign/remove roles,
**So that** membership stays current and personal.

### Acceptance Criteria
- Given a member, when they leave the community, then their membership (and role assignments) is removed and a `member_left` change is emitted; the owner cannot leave their own community this way (must delete it).
- Given a member, when they set their own nickname, then member listings show the nickname; nickname changes require only self-ownership of the membership (managing **others'** nicknames requires `MANAGE_ROLES`).
- Given a member with `MANAGE_ROLES`, when they assign or remove a role on another member, then the change is stored, a `member_roles_changed` change is emitted, and hierarchy rules apply (cannot assign/remove a role at or above the actor's highest role, and not on the owner).
- Given a member without `MANAGE_ROLES`, when they attempt to assign or remove roles, then they are rejected.

### Out of Scope
- Nickname moderation policies beyond role hierarchy.

---

## Invites

## US-010: Create and manage link invites

**As a** member with `CREATE_INVITE`,
**I want to** generate shareable invite links with optional expiry and max uses, list active invites, and revoke them,
**So that** I control how people get in.

### Acceptance Criteria
- Given a member with `CREATE_INVITE`, when they create a link invite with optional `expires_in_seconds` and `max_uses`, then they receive a random invite code, its URL, and expiry.
- Given the same member, when they list invites, then they see the community's active invites.
- Given the inviter (or a member with `MANAGE_CHANNELS`-equivalent admin rights), when they revoke an invite by code, then the code stops working immediately (previews/accepts return `invite_revoked`).
- Given a member without `CREATE_INVITE`, when they attempt to create an invite, then they are rejected; invite creation is rate-limited per user.

### Out of Scope
- Vanity invite codes; invite usage analytics beyond used counts.

## US-011: Invite a person by email

**As a** member with `CREATE_INVITE`,
**I want to** invite an email address directly,
**So that** non-users can receive an invitation to join.

### Acceptance Criteria
- Given a member with `CREATE_INVITE`, when they submit an email invite with an optional expiry, then the service accepts the request (`202`), creates the underlying invite record, and queues an email event — the response does not block on email delivery.
- Given the email invite is created, when the event flows to the notification pipeline, then it carries everything needed to render the email (community name, invite URL, inviter username, recipient email, expiry).
- Given an invalid email address, when submitted, then the request is rejected with a validation error.

### Out of Scope
- Sending the email itself (owned by `notification_service`); invite email templates (owned there too).

---

## Moderation

## US-012: Timeout a member

**As a** moderator with `TIMEOUT_MEMBERS`,
**I want to** time out a member for a bounded duration with a reason and an optional member-facing explanation,
**So that** disruptive members cool down without losing their membership.

### Acceptance Criteria
- Given a moderator with `TIMEOUT_MEMBERS`, when they time out a member for a duration up to 28 days, then the member's timeout state is stored, a `member_timed_out` change (with expiry, member-facing explanation, and voice channel ids) is emitted, and an audit entry records actor/action/target/reason.
- Given a timed-out member, when they attempt a blocked action (e.g. sending messages via peer services or actions gated on their timeout), then they are rejected with `403 member_timed_out` including their `timed_out_until` and the member-facing explanation.
- Given a moderator, when they attempt to time out the owner or a member holding an equal-or-higher role, then they are rejected.
- Given a duration above 28 days (or invalid), when submitted, then the request is rejected.

### Out of Scope
- Permanent timeouts (use ban); shadow timeouts.

## US-013: Clear a timeout

**As a** moderator with `TIMEOUT_MEMBERS`,
**I want to** clear a member's timeout early,
**So that** I can reverse a mistaken or overly strict action.

### Acceptance Criteria
- Given a timed-out member, when a moderator with `TIMEOUT_MEMBERS` clears the timeout, then the timeout state is removed, a `member_timeout_cleared` change is emitted, and an audit entry is written.
- Given a member who is not timed out, when the timeout is cleared, then the operation is idempotent (succeeds, no state change).

### Out of Scope
- Automatic notifications beyond the emitted event.

## US-014: Kick a member

**As a** moderator with `KICK_MEMBERS`,
**I want to** remove a member from the community with a reason and optional member-facing explanation,
**So that** the member can rejoin later via a valid invite if invited again.

### Acceptance Criteria
- Given a moderator with `KICK_MEMBERS`, when they kick a member, then the membership and its role assignments are removed, a `member_kicked` change (with member-facing explanation and voice channel ids) is emitted, and an audit entry is written.
- Given a kicked member, when they hit a community endpoint, then they no longer have member access; live subscribers see them removed and voice rooms evict them.
- Given a moderator, when they attempt to kick the owner or a member holding an equal-or-higher role, then they are rejected.

### Out of Scope
- Re-kick cooldowns.

## US-015: Ban and unban a member

**As a** moderator with `BAN_MEMBERS`,
**I want to** ban a member (optionally with an expiry) and unban them,
**So that** I can permanently or temporarily exclude disruptive users.

### Acceptance Criteria
- Given a moderator with `BAN_MEMBERS`, when they ban a member (optionally with `expires_at`), then the membership is removed, a ban record is created, a `member_banned` change (with member-facing explanation and optional ban expiry) is emitted, and an audit entry is written.
- Given a banned user, when they accept any invite to the community, then they are rejected with `403 banned` and the member-facing explanation; while the ban is active they cannot rejoin.
- Given a banned user whose ban has expired, when they accept a valid invite, then they can join again.
- Given a moderator with `BAN_MEMBERS`, when they list bans, then they see a paginated ban list; when they unban a user, the ban is lifted, a `member_unbanned` change is emitted, and an audit entry is written.
- Given a moderator, when they attempt to ban the owner or a member holding an equal-or-higher role, then they are rejected.

### Out of Scope
- Community-wide ban evasion countermeasures; server-level bans.

---

## Audit log

## US-016: Audit log of every administrative change

**As a** member with `VIEW_AUDIT_LOG`,
**I want to** review a paginated, filterable audit log of moderation and administration actions,
**So that** accountability is traceable.

### Acceptance Criteria
- Given any moderation action (timeout, timeout clear, kick, ban, unban) and any administration change (role, permission overwrite, channel, invite), when the change commits, then an audit entry with actor, action, target, reason, and before/after summary is written **in the same transaction** as the change itself.
- Given a member with `VIEW_AUDIT_LOG`, when they query the audit log with optional `action`, `actor_id`, and `target_id` filters and a cursor, then they receive a paginated list ordered newest-first.
- Given a member without `VIEW_AUDIT_LOG`, when they query the audit log, then they are rejected with a missing-permission error.

### Out of Scope
- Audit log retention/export tooling.

---

## Internal access decisions (peer-service contract)

## US-017: Authoritative per-channel access check

**As a** peer service (chat or voice),
**I want to** ask whether a user may view, read history, send, connect, speak, or stream video in a channel,
**So that** I never make my own authorization decisions.

### Acceptance Criteria
- Given a peer service with the internal service token, when it checks per-channel access for a user, then it receives `{community_id, channel_type, is_member, can_view, can_read_history, can_send, can_connect, can_speak, can_video, timed_out_until, banned}` resolved by the full permission model.
- Given a user who is banned or not a member, when checked, then the response reflects that state (e.g. `banned: true` or `is_member: false`) so the caller fails closed.
- Given a request without a valid internal service token, when it reaches the internal endpoint, then it is rejected with `401` and never reaches business logic.

### Out of Scope
- Caching policy inside peer services (they may cache briefly but must treat this service as authoritative).

## US-018: Community member access for gateway subscriptions

**As a** peer service (realtime gateway),
**I want to** know which channels a member may see and their timeout/ban state,
**So that** I can authorize community subscriptions and event delivery.

### Acceptance Criteria
- Given the gateway with the internal service token, when it checks member access for a community, then it receives `{is_member, banned, visible_channel_ids[], timed_out_until}`.
- Given a user whose roles or overwrites change, when the gateway re-checks after a `community_events` change, then the response reflects the **current** effective permissions.

### Out of Scope
- Pushing access changes to the gateway (delivered via `community_events`, not a callback).

---

## Operational

## US-019: Health and readiness probes

**As a** container platform,
**I want to** probe liveness and readiness,
**So that** traffic only reaches a fully capable pod.

### Acceptance Criteria
- Given a running pod, when `/healthz` is called, then it returns a lightweight success as long as the process is responsive, regardless of transient downstream hiccups.
- Given the PostgreSQL connection pool and Kafka producer are ready, when `/readyz` is called, then it returns success; when either is not ready or shutdown has started, then it returns `503`.

### Out of Scope
- Deep dependency health checks in liveness.

## US-020: Reliable domain event publication

**As a** downstream consumer (gateway, voice, chat, notification),
**I want to** receive exactly the events matching committed state changes,
**So that** live UI and enforcement never diverge from the database.

### Acceptance Criteria
- Given any state change with a corresponding domain event, when the transaction commits, then the event is persisted in the same transaction and published reliably afterward (transactional outbox), in per-community order for `community_events`.
- Given a publish failure (Kafka unavailable), when the relay retries, then events are eventually published without duplication; consumers dedupe by `event_id`.
- Given a deleted community or channel, when the deletion commits, then `community_deleted` (with channel ids) or `channel_deleted` is published so peer services purge dependent data.