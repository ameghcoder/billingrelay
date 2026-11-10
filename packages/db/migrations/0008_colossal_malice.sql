CREATE TABLE "credit_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"source_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_account_customer_unique" UNIQUE("project_id","environment","customer_id"),
	CONSTRAINT "credit_account_environment_check" CHECK ("credit_account"."environment" IN ('sandbox', 'live'))
);
--> statement-breakpoint
CREATE TABLE "credit_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"lot_id" uuid,
	"usage_id" text,
	"debit_id" uuid,
	"allocation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_entry_kind_check" CHECK ("credit_entry"."kind" IN ('grant', 'debit', 'compensation', 'expiry'))
);
--> statement-breakpoint
CREATE TABLE "credit_lot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"amount" bigint NOT NULL,
	"remaining" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"paypal_payment_id" text NOT NULL,
	"checkout_id" uuid,
	"subscription_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_lot_payment_unique" UNIQUE("paypal_payment_id"),
	CONSTRAINT "credit_lot_bucket_check" CHECK ("credit_lot"."bucket" IN ('monthly', 'pack')),
	CONSTRAINT "credit_lot_status_check" CHECK ("credit_lot"."status" IN ('active', 'restricted')),
	CONSTRAINT "credit_lot_remaining_check" CHECK ("credit_lot"."remaining" >= 0 AND "credit_lot"."remaining" <= "credit_lot"."amount")
);
--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_entity_type_check";--> statement-breakpoint
ALTER TABLE "credit_account" ADD CONSTRAINT "credit_account_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_account" ADD CONSTRAINT "credit_account_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_account_id_credit_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."credit_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_lot_id_credit_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."credit_lot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_lot" ADD CONSTRAINT "credit_lot_account_id_credit_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."credit_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_lot" ADD CONSTRAINT "credit_lot_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_lot" ADD CONSTRAINT "credit_lot_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_entry_usage_unique" ON "credit_entry" USING btree ("project_id","environment","usage_id") WHERE "credit_entry"."kind" = 'debit';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_entry_compensation_unique" ON "credit_entry" USING btree ("debit_id") WHERE "credit_entry"."kind" = 'compensation';--> statement-breakpoint
CREATE INDEX "credit_entry_account_idx" ON "credit_entry" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_lot_account_idx" ON "credit_lot" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_entity_type_check" CHECK ("outbox"."entity_type" IN ('checkout', 'access_grant', 'subscription', 'credit_account'));