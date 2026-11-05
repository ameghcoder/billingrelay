CREATE TABLE "paypal_connection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"client_id" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"webhook_id" text,
	"webhook_status" text DEFAULT 'not_registered' NOT NULL,
	"webhook_error" text,
	"capabilities" jsonb,
	"last_check" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_connection_project_environment_unique" UNIQUE("project_id","environment"),
	CONSTRAINT "paypal_connection_environment_check" CHECK ("paypal_connection"."environment" IN ('sandbox', 'live')),
	CONSTRAINT "paypal_connection_webhook_status_check" CHECK ("paypal_connection"."webhook_status" IN ('registered', 'not_registered'))
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paypal_connection" ADD CONSTRAINT "paypal_connection_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;