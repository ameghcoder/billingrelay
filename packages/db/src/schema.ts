import type { CatalogConfig } from "@billingrelay/core/catalog";
import type { MoneyReason, StoredMoneyStatus } from "@billingrelay/core/checkouts";
import type { QuoteSnapshot } from "@billingrelay/core/quotes";
import { sql } from "drizzle-orm";
import { boolean, check, integer, json, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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

// One row per saved version, never updated. Nothing in packages/db can change a row after inserting it.
export const catalogVersion = pgTable(
  "catalog_version",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    version: integer("version").notNull(),
    // json, not jsonb: keeps the exact document that was validated, including its key order.
    config: json("config").$type<CatalogConfig>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
  },
  (table) => [
    unique("catalog_version_project_environment_version_unique").on(table.projectId, table.environment, table.version),
    check("catalog_version_environment_check", sql`${table.environment} IN ('sandbox', 'live')`),
    check("catalog_version_version_check", sql`${table.version} > 0`),
  ],
);

// Which version is live: one row per project and environment.
export const catalogActive = pgTable(
  "catalog_active",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => catalogVersion.id),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    activatedBy: text("activated_by")
      .notNull()
      .references(() => user.id),
  },
  (table) => [
    primaryKey({ name: "catalog_active_pkey", columns: [table.projectId, table.environment] }),
    check("catalog_active_environment_check", sql`${table.environment} IN ('sandbox', 'live')`),
  ],
);

// The key itself is never stored. It decides the project and environment of every /v1 request.
export const apiKey = pgTable(
  "api_key",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    lastFour: text("last_four").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("api_key_key_hash_unique").on(table.keyHash),
    check("api_key_environment_check", sql`${table.environment} IN ('sandbox', 'live')`),
  ],
);

// The merchant's own user ID identifies a customer. Email never does.
export const customer = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    externalCustomerId: text("external_customer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("customer_project_external_unique").on(table.projectId, table.externalCustomerId)],
);

// Never updated. Nothing in packages/db can change a row after inserting it.
export const quote = pgTable(
  "quote",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKey.id),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    // json, not jsonb: keeps the exact document, including its key order.
    snapshot: json("snapshot").$type<QuoteSnapshot>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("quote_project_environment_key_unique").on(table.projectId, table.environment, table.idempotencyKey),
    check("quote_environment_check", sql`${table.environment} IN ('sandbox', 'live')`),
  ],
);

// Where a checkout may send the buyer afterwards. An exact origin, so a lookalike host doesn't match.
export const returnOrigin = pgTable(
  "return_origin",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    origin: text("origin").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
  },
  (table) => [
    unique("return_origin_project_environment_origin_unique").on(table.projectId, table.environment, table.origin),
    check("return_origin_environment_check", sql`${table.environment} IN ('sandbox', 'live')`),
  ],
);

export const checkout = pgTable(
  "checkout",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKey.id),
    // One quote gets one checkout, ever. Empty for a checkout straight from the catalog.
    quoteId: uuid("quote_id").references(() => quote.id),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    returnUrl: text("return_url").notNull(),
    // json, not jsonb: keeps the exact document. Never updated.
    snapshot: json("snapshot").$type<QuoteSnapshot>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    moneyStatus: text("money_status").$type<StoredMoneyStatus>().notNull().default("pending"),
    moneyReason: text("money_reason").$type<MoneyReason>(),
    // Written before calling PayPal, so a crash can't look like "nothing happened".
    captureRequestedAt: timestamp("capture_requested_at", { withTimezone: true }),
    paypalOrderId: text("paypal_order_id"),
    paypalSellerId: text("paypal_seller_id"),
    paypalCaptureId: text("paypal_capture_id"),
    // What PayPal reported, kept apart from the snapshot so a mismatch can be reviewed.
    capturedAmount: integer("captured_amount"),
    capturedCurrency: text("captured_currency"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("checkout_project_environment_key_unique").on(table.projectId, table.environment, table.idempotencyKey),
    unique("checkout_quote_unique").on(table.quoteId),
    unique("checkout_paypal_order_unique").on(table.paypalOrderId),
    unique("checkout_paypal_capture_unique").on(table.paypalCaptureId),
    check("checkout_environment_check", sql`${table.environment} IN ('sandbox', 'live')`),
    check("checkout_money_status_check", sql`${table.moneyStatus} IN ('pending', 'approved', 'captured', 'failed', 'unresolved', 'refund_review')`),
  ],
);

// Verified PayPal events, stored before they're acknowledged. Holds PayPal's raw body, which names the buyer.
export const paypalEvent = pgTable(
  "paypal_event",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => paypalConnection.id),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: json("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("paypal_event_connection_event_unique").on(table.connectionId, table.eventId)],
);

export type ProjectScope = { projectId: string; environment: "sandbox" | "live" };
