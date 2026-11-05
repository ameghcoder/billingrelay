CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_four" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_key_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_key_environment_check" CHECK ("api_key"."environment" IN ('sandbox', 'live'))
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"external_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_project_external_unique" UNIQUE("project_id","external_customer_id")
);
--> statement-breakpoint
CREATE TABLE "quote" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"snapshot" json NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_project_environment_key_unique" UNIQUE("project_id","environment","idempotency_key"),
	CONSTRAINT "quote_environment_check" CHECK ("quote"."environment" IN ('sandbox', 'live'))
);
--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote" ADD CONSTRAINT "quote_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote" ADD CONSTRAINT "quote_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote" ADD CONSTRAINT "quote_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE no action ON UPDATE no action;