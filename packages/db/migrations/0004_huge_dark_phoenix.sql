CREATE TABLE "checkout" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"quote_id" uuid,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"return_url" text NOT NULL,
	"snapshot" json NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"money_status" text DEFAULT 'pending' NOT NULL,
	"money_reason" text,
	"capture_requested_at" timestamp with time zone,
	"paypal_order_id" text,
	"paypal_seller_id" text,
	"paypal_capture_id" text,
	"captured_amount" integer,
	"captured_currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_project_environment_key_unique" UNIQUE("project_id","environment","idempotency_key"),
	CONSTRAINT "checkout_quote_unique" UNIQUE("quote_id"),
	CONSTRAINT "checkout_paypal_order_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "checkout_paypal_capture_unique" UNIQUE("paypal_capture_id"),
	CONSTRAINT "checkout_environment_check" CHECK ("checkout"."environment" IN ('sandbox', 'live')),
	CONSTRAINT "checkout_money_status_check" CHECK ("checkout"."money_status" IN ('pending', 'approved', 'captured', 'failed', 'unresolved', 'refund_review'))
);
--> statement-breakpoint
CREATE TABLE "paypal_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" json NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_event_connection_event_unique" UNIQUE("connection_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "return_origin" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"origin" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "return_origin_project_environment_origin_unique" UNIQUE("project_id","environment","origin"),
	CONSTRAINT "return_origin_environment_check" CHECK ("return_origin"."environment" IN ('sandbox', 'live'))
);
--> statement-breakpoint
ALTER TABLE "checkout" ADD CONSTRAINT "checkout_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout" ADD CONSTRAINT "checkout_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout" ADD CONSTRAINT "checkout_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout" ADD CONSTRAINT "checkout_quote_id_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quote"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_event" ADD CONSTRAINT "paypal_event_connection_id_paypal_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."paypal_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_origin" ADD CONSTRAINT "return_origin_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_origin" ADD CONSTRAINT "return_origin_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;