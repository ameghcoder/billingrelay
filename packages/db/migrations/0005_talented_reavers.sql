CREATE TABLE "access_grant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"access_key" text NOT NULL,
	"checkout_id" uuid NOT NULL,
	"paypal_payment_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_grant_environment_check" CHECK ("access_grant"."environment" IN ('sandbox', 'live')),
	CONSTRAINT "access_grant_status_check" CHECK ("access_grant"."status" IN ('active', 'restricted'))
);
--> statement-breakpoint
CREATE TABLE "billing_effect" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"checkout_id" uuid NOT NULL,
	"paypal_payment_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_effect_payment_kind_unique" UNIQUE("paypal_payment_id","kind")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"source_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_entity_version_unique" UNIQUE("entity_type","entity_id","source_version"),
	CONSTRAINT "outbox_entity_type_check" CHECK ("outbox"."entity_type" IN ('checkout', 'access_grant'))
);
--> statement-breakpoint
ALTER TABLE "checkout" ADD COLUMN "fulfillment_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout" ADD COLUMN "fulfillment_reason" text;--> statement-breakpoint
ALTER TABLE "checkout" ADD COLUMN "source_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout" ADD COLUMN "next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout" ADD COLUMN "check_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_event" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_event" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_event" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_event" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "paypal_event" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_effect" ADD CONSTRAINT "billing_effect_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_effect" ADD CONSTRAINT "billing_effect_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grant_customer_idx" ON "access_grant" USING btree ("project_id","environment","customer_id");--> statement-breakpoint
CREATE INDEX "access_grant_checkout_idx" ON "access_grant" USING btree ("checkout_id");--> statement-breakpoint
CREATE INDEX "checkout_needs_work_idx" ON "checkout" USING btree ("next_check_at") WHERE "checkout"."fulfillment_status" = 'pending' AND "checkout"."money_status" IN ('approved', 'captured', 'unresolved');--> statement-breakpoint
CREATE INDEX "paypal_event_due_idx" ON "paypal_event" USING btree ("next_attempt_at") WHERE "paypal_event"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "checkout" ADD CONSTRAINT "checkout_fulfillment_status_check" CHECK ("checkout"."fulfillment_status" IN ('pending', 'applied', 'restricted', 'failed'));--> statement-breakpoint
ALTER TABLE "paypal_event" ADD CONSTRAINT "paypal_event_status_check" CHECK ("paypal_event"."status" IN ('pending', 'processed', 'ignored', 'failed'));