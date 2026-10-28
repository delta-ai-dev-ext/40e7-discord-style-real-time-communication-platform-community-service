CREATE TABLE "audit_log_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"community_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"reason" text,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ban" (
	"id" uuid PRIMARY KEY NOT NULL,
	"community_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"member_message" text,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel" (
	"id" uuid PRIMARY KEY NOT NULL,
	"community_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"type" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_name_length" CHECK (length("channel"."name") >= 1),
	CONSTRAINT "channel_type_allowed" CHECK ("channel"."type" in ('text','voice'))
);
--> statement-breakpoint
CREATE TABLE "community" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_name_length" CHECK (length("community"."name") >= 1)
);
--> statement-breakpoint
CREATE TABLE "email_invite" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invite_id" uuid NOT NULL,
	"community_id" uuid NOT NULL,
	"recipient_email" text NOT NULL,
	"community_name" text NOT NULL,
	"inviter_user_id" text NOT NULL,
	"inviter_username" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_invite_status_allowed" CHECK ("email_invite"."status" in ('queued','emitted'))
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"id" uuid PRIMARY KEY NOT NULL,
	"community_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_code_unique" UNIQUE("code"),
	CONSTRAINT "invite_max_uses_positive" CHECK ("invite"."max_uses" is null or "invite"."max_uses" >= 1)
);
--> statement-breakpoint
CREATE TABLE "member_role" (
	"community_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_by" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_role_community_id_user_id_role_id_pk" PRIMARY KEY("community_id","user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY NOT NULL,
	"community_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"nickname" text,
	"timed_out_until" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"event_type" text NOT NULL,
	"partition_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"trace_parent" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "outbox_event_topic_allowed" CHECK ("outbox_event"."topic" in ('community_events','community_invite_events')),
	CONSTRAINT "outbox_event_status_allowed" CHECK ("outbox_event"."status" in ('pending','published'))
);
--> statement-breakpoint
CREATE TABLE "permission_overwrite" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"allow" text[] DEFAULT '{}'::text[] NOT NULL,
	"deny" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_overwrite_target_type_allowed" CHECK ("permission_overwrite"."target_type" in ('role','member')),
	CONSTRAINT "permission_overwrite_no_overlap" CHECK (not ("permission_overwrite"."allow" && "permission_overwrite"."deny"))
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY NOT NULL,
	"community_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer NOT NULL,
	"is_everyone" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log_entry" ADD CONSTRAINT "audit_log_entry_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ban" ADD CONSTRAINT "ban_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_invite" ADD CONSTRAINT "email_invite_invite_id_invite_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invite"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_invite" ADD CONSTRAINT "email_invite_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_overwrite" ADD CONSTRAINT "permission_overwrite_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_community_id_community_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."community"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_community_created_idx" ON "audit_log_entry" USING btree ("community_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_community_action_idx" ON "audit_log_entry" USING btree ("community_id","action");--> statement-breakpoint
CREATE INDEX "audit_log_community_actor_idx" ON "audit_log_entry" USING btree ("community_id","actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_community_target_idx" ON "audit_log_entry" USING btree ("community_id","target");--> statement-breakpoint
CREATE UNIQUE INDEX "ban_community_user_unique" ON "ban" USING btree ("community_id","user_id");--> statement-breakpoint
CREATE INDEX "channel_community_position_idx" ON "channel" USING btree ("community_id","position");--> statement-breakpoint
CREATE INDEX "invite_community_active_idx" ON "invite" USING btree ("community_id") WHERE "invite"."revoked" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "membership_community_user_unique" ON "membership" USING btree ("community_id","user_id");--> statement-breakpoint
CREATE INDEX "membership_user_idx" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outbox_event_status_created_idx" ON "outbox_event" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outbox_event_partition_created_idx" ON "outbox_event" USING btree ("partition_key","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "permission_overwrite_target_unique" ON "permission_overwrite" USING btree ("channel_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "role_community_position_idx" ON "role" USING btree ("community_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "role_community_everyone_unique" ON "role" USING btree ("community_id") WHERE "role"."is_everyone" = true;