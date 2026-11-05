CREATE TABLE "catalog_active" (
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"version_id" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" text NOT NULL,
	CONSTRAINT "catalog_active_pkey" PRIMARY KEY("project_id","environment"),
	CONSTRAINT "catalog_active_environment_check" CHECK ("catalog_active"."environment" IN ('sandbox', 'live'))
);
--> statement-breakpoint
CREATE TABLE "catalog_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"version" integer NOT NULL,
	"config" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "catalog_version_project_environment_version_unique" UNIQUE("project_id","environment","version"),
	CONSTRAINT "catalog_version_environment_check" CHECK ("catalog_version"."environment" IN ('sandbox', 'live')),
	CONSTRAINT "catalog_version_version_check" CHECK ("catalog_version"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "catalog_active" ADD CONSTRAINT "catalog_active_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_active" ADD CONSTRAINT "catalog_active_version_id_catalog_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."catalog_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_active" ADD CONSTRAINT "catalog_active_activated_by_user_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_version" ADD CONSTRAINT "catalog_version_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_version" ADD CONSTRAINT "catalog_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;