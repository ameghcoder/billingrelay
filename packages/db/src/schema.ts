import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

// Better Auth expects these four tables and column names.
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Single row, updated through a pg-boss job so it proves the queue round trip works.
export const workerHeartbeat = pgTable("worker_heartbeat", {
  id: integer("id").primaryKey().default(1),
  lastBeatAt: timestamp("last_beat_at", { withTimezone: true }).notNull(),
});

export const project = pgTable("project", {
  id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const paypalConnection = pgTable(
  "paypal_connection",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    clientId: text("client_id").notNull(),
    secretEncrypted: text("secret_encrypted").notNull(),
    webhookId: text("webhook_id"),
    webhookStatus: text("webhook_status").$type<"registered" | "not_registered">().notNull().default("not_registered"),
    webhookError: text("webhook_error"),
    capabilities: jsonb("capabilities").$type<{ checkout: boolean; subscriptions: boolean; webhooks: boolean }>(),
    lastCheck: text("last_check"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("paypal_connection_project_environment_unique").on(table.projectId, table.environment),
    check("paypal_connection_environment_check", sql`${table.environment} IN ('sandbox', 'live')`),
    check("paypal_connection_webhook_status_check", sql`${table.webhookStatus} IN ('registered', 'not_registered')`),
  ],
);
