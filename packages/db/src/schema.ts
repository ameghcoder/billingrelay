import type { CatalogConfig } from "@billingrelay/core/catalog";
import type { FulfillmentReason, FulfillmentStatus, MoneyReason, StoredMoneyStatus } from "@billingrelay/core/checkouts";
import type { QuoteSnapshot } from "@billingrelay/core/quotes";
import type { SubscriptionReviewReason, SubscriptionStatus } from "@billingrelay/core/subscriptions";
import type { DestinationState, OutboxStatus, SyncOutcome } from "@billingrelay/core/sync";
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, json, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

// A person approved this exact version. The hash is of its stored config, checked again when it goes live, so an approval
// can't carry over to anything else, even a row changed by hand.
export const catalogApproval = pgTable(
  "catalog_approval",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    versionId: uuid("version_id")
      .notNull()
      .references(() => catalogVersion.id),
    configHash: text("config_hash").notNull(),
    approvedBy: text("approved_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("catalog_approval_version_unique").on(table.versionId)],
);

// Who did what to configuration: a person, the AI setup agent or an MCP client. Hashes and IDs, never customer data or prompts.
export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    actorKind: text("actor_kind").$type<"operator" | "ai" | "mcp">().notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("audit_event_actor_kind_check", sql`${table.actorKind} IN ('operator', 'ai', 'mcp')`),
    index("audit_event_project_idx").on(table.projectId, table.createdAt),
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
    fulfillmentStatus: text("fulfillment_status").$type<FulfillmentStatus>().notNull().default("pending"),
    fulfillmentReason: text("fulfillment_reason").$type<FulfillmentReason>(),
    // Goes up by one with each billing change, in the same transaction. The destination only accepts a newer one.
    sourceVersion: integer("source_version").notNull().default(0),
    // When the worker may look at this checkout again without any event telling it to.
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    checkAttempts: integer("check_attempts").notNull().default(0),
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
    check("checkout_fulfillment_status_check", sql`${table.fulfillmentStatus} IN ('pending', 'applied', 'restricted', 'failed')`),
    index("checkout_needs_work_idx")
      .on(table.nextCheckAt)
      .where(sql`${table.fulfillmentStatus} = 'pending' AND ${table.moneyStatus} IN ('approved', 'captured', 'unresolved')`),
  ],
);

// Verified PayPal events, stored before they're acknowledged. Holds PayPal's raw body, which names the buyer.
// The row is the job: `next_attempt_at` is both the retry time and the lease, so a killed worker's event comes back by itself.
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
    status: text("status").$type<PaypalEventStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    failureCode: text("failure_code"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    unique("paypal_event_connection_event_unique").on(table.connectionId, table.eventId),
    check("paypal_event_status_check", sql`${table.status} IN ('pending', 'processed', 'ignored', 'failed')`),
    index("paypal_event_due_idx").on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
  ],
);

// One row per effect of one payment. Only a newly inserted row changes anything, however many signals arrive.
export const billingEffect = pgTable(
  "billing_effect",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    checkoutId: uuid("checkout_id")
      .notNull()
      .references(() => checkout.id),
    // A capture ID now, and a sale ID for subscriptions from M09.
    paypalPaymentId: text("paypal_payment_id").notNull(),
    kind: text("kind").$type<"access">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("billing_effect_payment_kind_unique").on(table.paypalPaymentId, table.kind)],
);

// One row per paid purchase, so refunding one restricts only that one. A customer has access while any of their grants is active.
export const accessGrant = pgTable(
  "access_grant",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id),
    accessKey: text("access_key").notNull(),
    checkoutId: uuid("checkout_id")
      .notNull()
      .references(() => checkout.id),
    paypalPaymentId: text("paypal_payment_id").notNull(),
    // A subscription's one grant. Each counted payment moves `active_until` forward; empty for a one-time purchase, which doesn't end.
    subscriptionId: uuid("subscription_id").references(() => subscription.id),
    activeUntil: timestamp("active_until", { withTimezone: true }),
    status: text("status").$type<"active" | "restricted">().notNull().default("active"),
    sourceVersion: integer("source_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("access_grant_environment_check", sql`${table.environment} IN ('sandbox', 'live')`),
    check("access_grant_status_check", sql`${table.status} IN ('active', 'restricted')`),
    index("access_grant_customer_idx").on(table.projectId, table.environment, table.customerId),
    index("access_grant_checkout_idx").on(table.checkoutId),
    unique("access_grant_subscription_unique").on(table.subscriptionId),
  ],
);

// Only points at a record. Delivery reads its current state, so a retry sends the latest and no buyer details are copied.
// The row is the delivery job, like `paypal_event`: `next_attempt_at` is both the retry time and the lease.
export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    entityType: text("entity_type").$type<"checkout" | "access_grant" | "subscription" | "credit_account">().notNull(),
    entityId: uuid("entity_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").$type<OutboxStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    failureCode: text("failure_code"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    unique("outbox_entity_version_unique").on(table.entityType, table.entityId, table.sourceVersion),
    check("outbox_entity_type_check", sql`${table.entityType} IN ('checkout', 'access_grant', 'subscription', 'credit_account')`),
    check("outbox_status_check", sql`${table.status} IN ('pending', 'delivered', 'failed')`),
    index("outbox_due_idx").on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
  ],
);

// The retry history. A destination check that fails has no outbox row. Codes only: error text can quote row values.
export const syncAttempt = pgTable(
  "sync_attempt",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    outboxId: uuid("outbox_id").references(() => outbox.id),
    outcome: text("outcome").$type<SyncOutcome>().notNull(),
    code: text("code"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("sync_attempt_outcome_check", sql`${table.outcome} IN ('delivered', 'unchanged', 'refused', 'down', 'not_ready')`),
    index("sync_attempt_created_idx").on(table.createdAt),
    index("sync_attempt_outbox_idx").on(table.outboxId),
  ],
);

// One row, written by the worker. The web app reads the destination's state here, so it never needs the destination's login.
export const syncStatus = pgTable(
  "sync_status",
  {
    id: integer("id").primaryKey().default(1),
    state: text("state").$type<DestinationState>().notNull(),
    code: text("code"),
    downSince: timestamp("down_since", { withTimezone: true }),
    // Checks in a row that failed, for the backoff. Reset by the first one that works.
    failures: integer("failures").notNull().default(0),
    nextTryAt: timestamp("next_try_at", { withTimezone: true }).notNull().defaultNow(),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("sync_status_single_row", sql`${table.id} = 1`),
    check("sync_status_state_check", sql`${table.state} IN ('not_configured', 'checking', 'ok', 'down', 'not_ready')`),
  ],
);

// One PayPal product and monthly plan per price. A new price is a new plan, so no subscriber's price changes under them.
export const paypalPlan = pgTable(
  "paypal_plan",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => paypalConnection.id),
    productRef: text("product_ref").notNull(),
    variantRef: text("variant_ref").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    paypalProductId: text("paypal_product_id").notNull(),
    paypalPlanId: text("paypal_plan_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("paypal_plan_price_unique").on(table.connectionId, table.productRef, table.variantRef, table.amount, table.currency)],
);

// One per subscription checkout, made when the buyer clicks Pay. PayPal's status is stored as read; access comes from `paid_through`.
export const subscription = pgTable(
  "subscription",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id),
    checkoutId: uuid("checkout_id")
      .notNull()
      .references(() => checkout.id),
    productRef: text("product_ref").notNull(),
    paypalPlanId: text("paypal_plan_id").notNull(),
    paypalSubscriptionId: text("paypal_subscription_id").notNull(),
    status: text("status").$type<SubscriptionStatus>().notNull().default("pending"),
    reviewReason: text("review_reason").$type<SubscriptionReviewReason>(),
    // PayPal's next billing time after the last counted payment. Access lasts 24 hours past it.
    paidThrough: timestamp("paid_through", { withTimezone: true }),
    nextBillingTime: timestamp("next_billing_time", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    sourceVersion: integer("source_version").notNull().default(1),
    // When the worker asks PayPal again with no event, in case a renewal's event never comes.
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("subscription_checkout_unique").on(table.checkoutId),
    unique("subscription_paypal_unique").on(table.paypalSubscriptionId),
    check("subscription_environment_check", sql`${table.environment} IN ('sandbox', 'live')`),
    check("subscription_status_check", sql`${table.status} IN ('pending', 'active', 'suspended', 'cancelled', 'expired')`),
    check(
      "subscription_review_reason_check",
      sql`${table.reviewReason} IN ('reference_mismatch', 'plan_mismatch', 'amount_mismatch', 'currency_mismatch')`,
    ),
    index("subscription_customer_idx").on(table.projectId, table.environment, table.customerId, table.productRef),
    index("subscription_due_idx").on(table.nextCheckAt).where(sql`${table.nextCheckAt} IS NOT NULL`),
  ],
);

// One row per PayPal sale: the "one effect per payment" for subscriptions. A sale ID is also the transaction ID PayPal lists.
export const subscriptionPayment = pgTable(
  "subscription_payment",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscription.id),
    paypalSaleId: text("paypal_sale_id").notNull(),
    amount: integer("amount"),
    currency: text("currency").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
    // `counts`, or why it didn't pay for a period.
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("subscription_payment_sale_unique").on(table.paypalSaleId), index("subscription_payment_subscription_idx").on(table.subscriptionId)],
);

// One per customer with credits. Its row is what a debit locks, so two spends at once happen one after the other.
export const creditAccount = pgTable(
  "credit_account",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id),
    sourceVersion: integer("source_version").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("credit_account_customer_unique").on(table.projectId, table.environment, table.customerId),
    check("credit_account_environment_check", sql`${table.environment} IN ('sandbox', 'live')`),
  ],
);

// What one payment granted, and what's left of it. Packs never end; a month's credits end with the paid month.
export const creditLot = pgTable(
  "credit_lot",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    accountId: uuid("account_id")
      .notNull()
      .references(() => creditAccount.id),
    bucket: text("bucket").$type<"monthly" | "pack">().notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    remaining: bigint("remaining", { mode: "number" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").$type<"active" | "restricted">().notNull().default("active"),
    // The capture or sale that paid for it: one grant per payment.
    paypalPaymentId: text("paypal_payment_id").notNull(),
    checkoutId: uuid("checkout_id").references(() => checkout.id),
    subscriptionId: uuid("subscription_id").references(() => subscription.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("credit_lot_payment_unique").on(table.paypalPaymentId),
    check("credit_lot_bucket_check", sql`${table.bucket} IN ('monthly', 'pack')`),
    check("credit_lot_status_check", sql`${table.status} IN ('active', 'restricted')`),
    check("credit_lot_remaining_check", sql`${table.remaining} >= 0 AND ${table.remaining} <= ${table.amount}`),
    index("credit_lot_account_idx").on(table.accountId),
  ],
);

// Append-only. Grants and compensations add, debits and expiries take away; the lots say where.
export const creditEntry = pgTable(
  "credit_entry",
  {
    id: uuid("id").primaryKey().$defaultFn(() => uuidv7()),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => creditAccount.id),
    kind: text("kind").$type<"grant" | "debit" | "compensation" | "expiry">().notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    lotId: uuid("lot_id").references(() => creditLot.id),
    usageId: text("usage_id"),
    debitId: uuid("debit_id"),
    allocation: jsonb("allocation").$type<{ lotId: string; amount: number }[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("credit_entry_kind_check", sql`${table.kind} IN ('grant', 'debit', 'compensation', 'expiry')`),
    // One debit per usage ID in a project and environment, and one compensation per debit.
    uniqueIndex("credit_entry_usage_unique").on(table.projectId, table.environment, table.usageId).where(sql`${table.kind} = 'debit'`),
    uniqueIndex("credit_entry_compensation_unique").on(table.debitId).where(sql`${table.kind} = 'compensation'`),
    index("credit_entry_account_idx").on(table.accountId, table.createdAt),
  ],
);

export type PaypalEventStatus = "pending" | "processed" | "ignored" | "failed";
export type ProjectScope = { projectId: string; environment: "sandbox" | "live" };
