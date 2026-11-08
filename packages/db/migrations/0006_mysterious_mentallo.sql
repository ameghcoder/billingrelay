CREATE TABLE "sync_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outbox_id" uuid,
	"outcome" text NOT NULL,
	"code" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_attempt_outcome_check" CHECK ("sync_attempt"."outcome" IN ('delivered', 'unchanged', 'refused', 'down', 'not_ready'))
);
--> statement-breakpoint
CREATE TABLE "sync_status" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"state" text NOT NULL,
	"code" text,
	"down_since" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"next_try_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_status_single_row" CHECK ("sync_status"."id" = 1),
	CONSTRAINT "sync_status_state_check" CHECK ("sync_status"."state" IN ('not_configured', 'checking', 'ok', 'down', 'not_ready'))
);
--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_attempt" ADD CONSTRAINT "sync_attempt_outbox_id_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_attempt_created_idx" ON "sync_attempt" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_attempt_outbox_idx" ON "sync_attempt" USING btree ("outbox_id");--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "outbox" USING btree ("next_attempt_at") WHERE "outbox"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_status_check" CHECK ("outbox"."status" IN ('pending', 'delivered', 'failed'));