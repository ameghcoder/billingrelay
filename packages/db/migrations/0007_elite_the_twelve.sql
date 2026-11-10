CREATE TABLE "paypal_plan" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"product_ref" text NOT NULL,
	"variant_ref" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"paypal_product_id" text NOT NULL,
	"paypal_plan_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_plan_price_unique" UNIQUE("connection_id","product_ref","variant_ref","amount","currency")
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"checkout_id" uuid NOT NULL,
	"product_ref" text NOT NULL,
	"paypal_plan_id" text NOT NULL,
	"paypal_subscription_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"review_reason" text,
	"paid_through" timestamp with time zone,
	"next_billing_time" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"source_version" integer DEFAULT 1 NOT NULL,
	"next_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_checkout_unique" UNIQUE("checkout_id"),
	CONSTRAINT "subscription_paypal_unique" UNIQUE("paypal_subscription_id"),
	CONSTRAINT "subscription_environment_check" CHECK ("subscription"."environment" IN ('sandbox', 'live')),
	CONSTRAINT "subscription_status_check" CHECK ("subscription"."status" IN ('pending', 'active', 'suspended', 'cancelled', 'expired')),
	CONSTRAINT "subscription_review_reason_check" CHECK ("subscription"."review_reason" IN ('reference_mismatch', 'plan_mismatch', 'amount_mismatch', 'currency_mismatch'))
);
--> statement-breakpoint
CREATE TABLE "subscription_payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"paypal_sale_id" text NOT NULL,
	"amount" integer,
	"currency" text NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_payment_sale_unique" UNIQUE("paypal_sale_id")
);
--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_entity_type_check";--> statement-breakpoint
ALTER TABLE "access_grant" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "access_grant" ADD COLUMN "active_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paypal_plan" ADD CONSTRAINT "paypal_plan_connection_id_paypal_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."paypal_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_checkout_id_checkout_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payment" ADD CONSTRAINT "subscription_payment_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_customer_idx" ON "subscription" USING btree ("project_id","environment","customer_id","product_ref");--> statement-breakpoint
CREATE INDEX "subscription_due_idx" ON "subscription" USING btree ("next_check_at") WHERE "subscription"."next_check_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "subscription_payment_subscription_idx" ON "subscription_payment" USING btree ("subscription_id");--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_subscription_unique" UNIQUE("subscription_id");--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_entity_type_check" CHECK ("outbox"."entity_type" IN ('checkout', 'access_grant', 'subscription'));