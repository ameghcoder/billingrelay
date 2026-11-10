CREATE TABLE "repair_action" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" text,
	"target_state" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"outcome" text,
	"proposed_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repair_action_kind_check" CHECK ("repair_action"."kind" IN ('retry_delivery', 'retry_event', 'retry_sync', 'recheck_payment')),
	CONSTRAINT "repair_action_status_check" CHECK ("repair_action"."status" IN ('proposed', 'approved', 'executed', 'refused'))
);
--> statement-breakpoint
ALTER TABLE "repair_action" ADD CONSTRAINT "repair_action_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repair_action_project_idx" ON "repair_action" USING btree ("project_id","created_at");