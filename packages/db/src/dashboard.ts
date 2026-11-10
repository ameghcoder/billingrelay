import type { FulfillmentStatus, MoneyReason, MoneyStatus } from "@billingrelay/core/checkouts";
import type { ProductActivity } from "@billingrelay/core/flow";
import { accessUntil, type SubscriptionReviewReason, type SubscriptionStatus } from "@billingrelay/core/subscriptions";
import type { CheckoutSyncStatus, DestinationState, OutboxStatus, SyncEntityType, SyncOutcome } from "@billingrelay/core/sync";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "./client";
import type { PaypalEventStatus, ProjectScope } from "./schema";

// Read-only queries for the operator dashboard. Codes and statuses only: never an event's payload, which names the buyer.

const UNCLEAR_AFTER_HOURS = 24;
const TRACE_CHECKOUTS = 50;

export type DashboardPage = { limit: number; offset: number };
export type DashboardPageOf<Row> = { rows: Row[]; total: number };

const iso = (value: string | Date) => new Date(value).toISOString();
const isoOrNull = (value: string | Date | null) => (value === null ? null : iso(value));
const and = (conditions: SQL[]) => (conditions.length === 0 ? sql`TRUE` : sql.join(conditions, sql` AND `));

/** `expired` is worked out on read, the same rule as `hasExpired` in core. */
const moneyOf = sql`
  CASE WHEN c.expires_at <= now() AND c.capture_requested_at IS NULL AND c.money_status IN ('pending', 'approved')
       THEN 'expired' ELSE c.money_status END`;

/** The worst state across a checkout and its grants, the same rule as `getCheckoutSync`. Needs `c` and `dest`. */
const syncOf = sql`
  CASE WHEN dest.state IS NULL OR dest.state = 'not_configured' THEN 'not_configured'
       WHEN o.failed > 0 THEN 'failed'
       WHEN o.pending > 0 OR o.total = 0 THEN 'pending'
       ELSE 'delivered' END`;

const outboxCounts = sql`
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE status = 'failed') AS failed,
           count(*) FILTER (WHERE status = 'pending') AS pending,
           count(*) AS total
    FROM outbox
    WHERE (entity_type = 'checkout' AND entity_id = c.id)
       OR (entity_type = 'access_grant' AND entity_id IN (SELECT id FROM access_grant WHERE checkout_id = c.id))
  ) o`;

/** One row per checkout in scope, with the three statuses kept separate. */
const checkoutRows = (scope: ProjectScope, extra: SQL = sql`TRUE`) => sql`
  SELECT c.id, c.created_at, c.updated_at, c.capture_requested_at, cu.external_customer_id,
         c.snapshot->'product'->>'ref' AS product_ref, (c.snapshot->>'amount')::bigint AS amount, c.snapshot->>'currency' AS currency,
         ${moneyOf} AS money, c.money_reason, c.fulfillment_status AS fulfillment, ${syncOf} AS sync,
         c.paypal_order_id, c.paypal_capture_id
  FROM checkout c
  JOIN customer cu ON cu.id = c.customer_id
  LEFT JOIN sync_status dest ON dest.id = 1
  ${outboxCounts}
  WHERE c.project_id = ${scope.projectId} AND c.environment = ${scope.environment} AND ${extra}`;

type CheckoutRowSql = {
  id: string;
  created_at: string;
  updated_at: string;
  capture_requested_at: string | null;
  external_customer_id: string;
  product_ref: string;
  amount: string;
  currency: string;
  money: MoneyStatus;
  money_reason: MoneyReason | null;
  fulfillment: FulfillmentStatus;
  sync: CheckoutSyncStatus;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
};

export type DashboardCheckout = {
  id: string;
  createdAt: string;
  updatedAt: string;
  externalCustomerId: string;
  productRef: string;
  amount: number;
  currency: string;
  money: MoneyStatus;
  moneyReason: MoneyReason | null;
  fulfillment: FulfillmentStatus;
  sync: CheckoutSyncStatus;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
};

const toCheckout = (row: CheckoutRowSql): DashboardCheckout => ({
  id: row.id,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  externalCustomerId: row.external_customer_id,
  productRef: row.product_ref,
  amount: Number(row.amount),
  currency: row.currency,
  money: row.money,
  moneyReason: row.money_reason,
  fulfillment: row.fulfillment,
  sync: row.sync,
  paypalOrderId: row.paypal_order_id,
  paypalCaptureId: row.paypal_capture_id,
});

/** `not_delivered` is every sync state but `delivered`: the "Paid, not synced" preset. */
export type CheckoutFilters = {
  money?: MoneyStatus;
  fulfillment?: FulfillmentStatus;
  sync?: CheckoutSyncStatus | "not_delivered";
};

export type DashboardCurrencyTotal = { currency: string; count: number; amount: number };

export async function listDashboardCheckouts(
  scope: ProjectScope,
  filters: CheckoutFilters,
  page: DashboardPage,
): Promise<DashboardPageOf<DashboardCheckout> & { totals: DashboardCurrencyTotal[] }> {
  const conditions: SQL[] = [];
  if (filters.money) conditions.push(sql`money = ${filters.money}`);
  if (filters.fulfillment) conditions.push(sql`fulfillment = ${filters.fulfillment}`);
  if (filters.sync === "not_delivered") conditions.push(sql`sync <> 'delivered'`);
  else if (filters.sync) conditions.push(sql`sync = ${filters.sync}`);
  const where = and(conditions);

  const db = getDb();
  const [{ rows }, { rows: totals }] = await Promise.all([
    db.execute<CheckoutRowSql>(sql`
      SELECT * FROM (${checkoutRows(scope)}) r WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${page.limit} OFFSET ${page.offset}`),
    // Grouped by currency: amounts in different currencies are never added together.
    db.execute<{ currency: string; count: number; amount: string }>(sql`
      SELECT currency, count(*)::int AS count, sum(amount)::bigint AS amount
      FROM (${checkoutRows(scope)}) r WHERE ${where}
      GROUP BY currency ORDER BY currency`),
  ]);
  return {
    rows: rows.map(toCheckout),
    total: totals.reduce((sum, row) => sum + row.count, 0),
    totals: totals.map((row) => ({ currency: row.currency, count: row.count, amount: Number(row.amount) })),
  };
}

/**
 * Every stored event in scope, with the checkout it's about when one matches. The payload is read here only to match,
 * by the same references as `readEvent` in the PayPal package, and never selected.
 */
const linkedEvents = (scope: ProjectScope) => sql`
  SELECT e.id, e.event_id, e.event_type, e.status, e.attempts, e.failure_code, e.received_at, e.processed_at,
         linked.id AS checkout_id, linked.customer_id
  FROM paypal_event e
  JOIN paypal_connection pc ON pc.id = e.connection_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(e.payload->'resource'->>'custom_id', e.payload->'resource'->'purchase_units'->0->>'custom_id') AS custom_id,
           e.payload->'resource'->>'id' AS resource_id,
           e.payload->'resource'->>'billing_agreement_id' AS billing_agreement_id,
           e.payload->'resource'->'supplementary_data'->'related_ids'->>'order_id' AS related_order_id,
           (SELECT substring(link->>'href' from '/v2/payments/captures/([^/?#]+)')
            FROM json_array_elements(CASE WHEN json_typeof(e.payload->'resource'->'links') = 'array'
                                          THEN e.payload->'resource'->'links' ELSE '[]'::json END) AS link
            WHERE link->>'rel' = 'up' LIMIT 1) AS up_capture_id
  ) ref
  LEFT JOIN LATERAL (
    SELECT c.id, c.customer_id FROM checkout c
    WHERE c.project_id = pc.project_id AND c.environment = pc.environment
      AND (c.id = CASE WHEN ref.custom_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ref.custom_id::uuid END
           OR c.paypal_order_id IN (ref.resource_id, ref.related_order_id)
           OR c.paypal_capture_id IN (ref.resource_id, ref.up_capture_id)
           OR c.id IN (SELECT checkout_id FROM subscription WHERE paypal_subscription_id IN (ref.resource_id, ref.billing_agreement_id)))
    ORDER BY c.id LIMIT 1
  ) linked ON TRUE
  WHERE pc.project_id = ${scope.projectId} AND pc.environment = ${scope.environment}`;

type EventRowSql = {
  id: string;
  event_id: string;
  event_type: string;
  status: PaypalEventStatus;
  attempts: number;
  failure_code: string | null;
  received_at: string;
  processed_at: string | null;
  checkout_id: string | null;
  external_customer_id: string | null;
};

export type DashboardEvent = {
  id: string;
  paypalEventId: string;
  eventType: string;
  status: PaypalEventStatus;
  attempts: number;
  failureCode: string | null;
  receivedAt: string;
  processedAt: string | null;
  checkoutId: string | null;
  externalCustomerId: string | null;
};

const toEvent = (row: EventRowSql): DashboardEvent => ({
  id: row.id,
  paypalEventId: row.event_id,
  eventType: row.event_type,
  status: row.status,
  attempts: row.attempts,
  failureCode: row.failure_code,
  receivedAt: iso(row.received_at),
  processedAt: isoOrNull(row.processed_at),
  checkoutId: row.checkout_id,
  externalCustomerId: row.external_customer_id,
});

export type EventFilters = { status?: PaypalEventStatus; eventType?: string };

export async function listDashboardEvents(
  scope: ProjectScope,
  filters: EventFilters,
  page: DashboardPage,
): Promise<DashboardPageOf<DashboardEvent> & { eventTypes: string[] }> {
  const conditions: SQL[] = [];
  if (filters.status) conditions.push(sql`e.status = ${filters.status}`);
  if (filters.eventType) conditions.push(sql`e.event_type = ${filters.eventType}`);
  const where = and(conditions);

  const db = getDb();
  const [{ rows }, { rows: counted }, { rows: types }] = await Promise.all([
    db.execute<EventRowSql>(sql`
      SELECT ev.*, cu.external_customer_id
      FROM (
        SELECT e.* FROM (${linkedEvents(scope)}) e WHERE ${where}
        ORDER BY e.received_at DESC, e.id DESC
        LIMIT ${page.limit} OFFSET ${page.offset}
      ) ev
      LEFT JOIN customer cu ON cu.id = ev.customer_id
      ORDER BY ev.received_at DESC, ev.id DESC`),
    db.execute<{ total: number }>(sql`
      SELECT count(*)::int AS total
      FROM paypal_event e JOIN paypal_connection pc ON pc.id = e.connection_id
      WHERE pc.project_id = ${scope.projectId} AND pc.environment = ${scope.environment} AND ${where}`),
    db.execute<{ event_type: string }>(sql`
      SELECT DISTINCT e.event_type
      FROM paypal_event e JOIN paypal_connection pc ON pc.id = e.connection_id
      WHERE pc.project_id = ${scope.projectId} AND pc.environment = ${scope.environment}
      ORDER BY e.event_type`),
  ]);
  return { rows: rows.map(toEvent), total: counted[0]!.total, eventTypes: types.map((row) => row.event_type) };
}

/** The checkout an outbox row belongs to, directly or through its grant or subscription. Needs `o`. */
const outboxCheckout = sql`
  CASE o.entity_type WHEN 'checkout' THEN o.entity_id
       WHEN 'access_grant' THEN (SELECT checkout_id FROM access_grant WHERE id = o.entity_id)
       ELSE (SELECT checkout_id FROM subscription WHERE id = o.entity_id) END`;

type DeliveryRowSql = {
  id: string;
  entity_type: SyncEntityType;
  entity_id: string;
  checkout_id: string | null;
  external_customer_id: string | null;
  source_version: number;
  status: OutboxStatus;
  attempts: number;
  failure_code: string | null;
  created_at: string;
  delivered_at: string | null;
  lag_seconds: number;
  last_outcome: SyncOutcome | null;
  last_code: string | null;
  last_duration_ms: number | null;
  last_at: string | null;
};

export type DashboardDelivery = {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  checkoutId: string | null;
  externalCustomerId: string | null;
  sourceVersion: number;
  status: OutboxStatus;
  attempts: number;
  failureCode: string | null;
  createdAt: string;
  deliveredAt: string | null;
  // Until delivered, or until now while it waits.
  lagSeconds: number;
  lastAttempt: { at: string; outcome: SyncOutcome; code: string | null; durationMs: number | null } | null;
};

const toDelivery = (row: DeliveryRowSql): DashboardDelivery => ({
  id: row.id,
  entityType: row.entity_type,
  entityId: row.entity_id,
  checkoutId: row.checkout_id,
  externalCustomerId: row.external_customer_id,
  sourceVersion: row.source_version,
  status: row.status,
  attempts: row.attempts,
  failureCode: row.failure_code,
  createdAt: iso(row.created_at),
  deliveredAt: isoOrNull(row.delivered_at),
  lagSeconds: Math.round(row.lag_seconds),
  lastAttempt:
    row.last_outcome && row.last_at
      ? { at: iso(row.last_at), outcome: row.last_outcome, code: row.last_code, durationMs: row.last_duration_ms }
      : null,
});

export type DeliveryFilters = { status?: OutboxStatus; entityType?: SyncEntityType };

export async function listDashboardDeliveries(scope: ProjectScope, filters: DeliveryFilters, page: DashboardPage): Promise<DashboardPageOf<DashboardDelivery>> {
  const conditions: SQL[] = [sql`o.project_id = ${scope.projectId}`];
  if (filters.status) conditions.push(sql`o.status = ${filters.status}`);
  if (filters.entityType) conditions.push(sql`o.entity_type = ${filters.entityType}`);
  const where = and(conditions);

  const db = getDb();
  const [{ rows }, { rows: counted }] = await Promise.all([
    db.execute<DeliveryRowSql>(sql`
      SELECT o.id, o.entity_type, o.entity_id, linked.checkout_id, cu.external_customer_id, o.source_version, o.status, o.attempts,
             o.failure_code, o.created_at, o.delivered_at,
             extract(epoch FROM COALESCE(o.delivered_at, now()) - o.created_at)::float8 AS lag_seconds,
             last.outcome AS last_outcome, last.code AS last_code, last.duration_ms AS last_duration_ms, last.created_at AS last_at
      FROM outbox o
      CROSS JOIN LATERAL (SELECT ${outboxCheckout} AS checkout_id) linked
      LEFT JOIN checkout c ON c.id = linked.checkout_id
      LEFT JOIN customer cu ON cu.id = c.customer_id
      LEFT JOIN LATERAL (
        SELECT outcome, code, duration_ms, created_at FROM sync_attempt
        WHERE outbox_id = o.id ORDER BY created_at DESC, id DESC LIMIT 1
      ) last ON TRUE
      WHERE ${where} AND (c.id IS NULL OR c.environment = ${scope.environment})
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${page.limit} OFFSET ${page.offset}`),
    db.execute<{ total: number }>(sql`
      SELECT count(*)::int AS total FROM outbox o
      LEFT JOIN checkout c ON c.id = ${outboxCheckout}
      WHERE ${where} AND (c.id IS NULL OR c.environment = ${scope.environment})`),
  ]);
  return { rows: rows.map(toDelivery), total: counted[0]!.total };
}

export type DashboardAttention = {
  failedEvents: number;
  // Approved or unresolved, with nothing changing it for a day.
  unclearCheckouts: number;
  failedDeliveries: number;
  destination: { state: DestinationState; code: string | null; downSince: string | null };
  webhook: { status: "registered" | "not_registered"; code: string | null } | null;
};

/** What needs a person. Each part only warns: nothing here blocks a checkout. */
export async function getDashboardAttention(scope: ProjectScope): Promise<DashboardAttention> {
  const { rows } = await getDb().execute<{
    failed_events: number;
    unclear_checkouts: number;
    failed_deliveries: number;
    destination_state: DestinationState | null;
    destination_code: string | null;
    down_since: string | null;
    webhook_status: "registered" | "not_registered" | null;
    webhook_error: string | null;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM paypal_event e JOIN paypal_connection pc ON pc.id = e.connection_id
       WHERE pc.project_id = ${scope.projectId} AND pc.environment = ${scope.environment} AND e.status = 'failed') AS failed_events,
      (SELECT count(*)::int FROM checkout c
       WHERE c.project_id = ${scope.projectId} AND c.environment = ${scope.environment}
         AND ${moneyOf} IN ('approved', 'unresolved')
         AND c.updated_at < now() - make_interval(hours => ${UNCLEAR_AFTER_HOURS})) AS unclear_checkouts,
      (SELECT count(*)::int FROM outbox WHERE project_id = ${scope.projectId} AND status = 'failed') AS failed_deliveries,
      s.state AS destination_state, s.code AS destination_code, s.down_since,
      pc.webhook_status, pc.webhook_error
    FROM (SELECT 1) AS one
    LEFT JOIN sync_status s ON s.id = 1
    LEFT JOIN paypal_connection pc ON pc.project_id = ${scope.projectId} AND pc.environment = ${scope.environment}`);
  const row = rows[0]!;
  return {
    failedEvents: row.failed_events,
    unclearCheckouts: row.unclear_checkouts,
    failedDeliveries: row.failed_deliveries,
    destination: { state: row.destination_state ?? "not_configured", code: row.destination_code, downSince: isoOrNull(row.down_since) },
    webhook: row.webhook_status ? { status: row.webhook_status, code: row.webhook_error } : null,
  };
}

export type TraceStep =
  | { kind: "checkout_created"; at: string }
  | { kind: "capture_requested"; at: string }
  | { kind: "event"; at: string; eventType: string; status: PaypalEventStatus; attempts: number; failureCode: string | null }
  | { kind: "effect"; at: string; effect: string; paypalPaymentId: string }
  | { kind: "grant"; at: string; grantId: string; accessKey: string; status: "active" | "restricted" }
  | {
      kind: "outbox";
      at: string;
      outboxId: string;
      entityType: SyncEntityType;
      sourceVersion: number;
      status: OutboxStatus;
      attempts: number;
      failureCode: string | null;
    }
  | {
      kind: "sync_attempt";
      at: string;
      outboxId: string;
      entityType: SyncEntityType;
      sourceVersion: number;
      outcome: SyncOutcome;
      code: string | null;
      durationMs: number | null;
    };

export type TraceCheckout = DashboardCheckout & { steps: TraceStep[] };
export type CustomerTrace = { externalCustomerId: string; checkouts: TraceCheckout[] };

// Rows written in one transaction share a timestamp, so ties keep the order they were made in.
const STEP_ORDER: Record<TraceStep["kind"], number> = {
  checkout_created: 0,
  capture_requested: 1,
  event: 2,
  effect: 3,
  grant: 4,
  outbox: 5,
  sync_attempt: 6,
};

/** One customer's latest checkouts, oldest first, each followed by what happened to it in time order. Null for an unknown customer. */
export async function getCustomerTrace(scope: ProjectScope, externalCustomerId: string): Promise<CustomerTrace | null> {
  const db = getDb();
  const { rows: customers } = await db.execute<{ id: string }>(sql`
    SELECT id FROM customer WHERE project_id = ${scope.projectId} AND external_customer_id = ${externalCustomerId}`);
  const customerId = customers[0]?.id;
  if (!customerId) return null;

  const { rows: checkoutRowsFound } = await db.execute<CheckoutRowSql>(sql`
    SELECT * FROM (${checkoutRows(scope, sql`c.customer_id = ${customerId}`)}) r
    ORDER BY created_at DESC, id DESC LIMIT ${TRACE_CHECKOUTS}`);
  const ids = checkoutRowsFound.map((row) => row.id);
  if (ids.length === 0) return { externalCustomerId, checkouts: [] };

  // The same checkouts as above, as a subquery, so no ID list is built into the SQL.
  const theseCheckouts = sql`
    SELECT id FROM checkout
    WHERE project_id = ${scope.projectId} AND environment = ${scope.environment} AND customer_id = ${customerId}
    ORDER BY created_at DESC, id DESC LIMIT ${TRACE_CHECKOUTS}`;

  const [events, effects, grants, outboxRows, attempts] = await Promise.all([
    db.execute<EventRowSql>(sql`
      SELECT e.*, NULL AS external_customer_id FROM (${linkedEvents(scope)}) e
      WHERE e.checkout_id IN (${theseCheckouts})
      ORDER BY e.received_at, e.id`),
    db.execute<{ checkout_id: string; kind: string; paypal_payment_id: string; created_at: string }>(sql`
      SELECT checkout_id, kind, paypal_payment_id, created_at FROM billing_effect
      WHERE checkout_id IN (${theseCheckouts})
      ORDER BY created_at, id`),
    db.execute<{ id: string; checkout_id: string; access_key: string; status: "active" | "restricted"; created_at: string }>(sql`
      SELECT id, checkout_id, access_key, status, created_at FROM access_grant
      WHERE checkout_id IN (${theseCheckouts})
      ORDER BY created_at, id`),
    db.execute<{
      id: string;
      checkout_id: string;
      entity_type: SyncEntityType;
      source_version: number;
      status: OutboxStatus;
      attempts: number;
      failure_code: string | null;
      created_at: string;
    }>(sql`
      SELECT o.id, ${outboxCheckout} AS checkout_id, o.entity_type, o.source_version, o.status, o.attempts, o.failure_code, o.created_at
      FROM outbox o
      WHERE o.project_id = ${scope.projectId} AND ${outboxCheckout} IN (${theseCheckouts})
      ORDER BY o.created_at, o.source_version, o.id`),
    db.execute<{
      outbox_id: string;
      checkout_id: string;
      entity_type: SyncEntityType;
      source_version: number;
      outcome: SyncOutcome;
      code: string | null;
      duration_ms: number | null;
      created_at: string;
    }>(sql`
      SELECT a.outbox_id, ${outboxCheckout} AS checkout_id, o.entity_type, o.source_version, a.outcome, a.code, a.duration_ms, a.created_at
      FROM sync_attempt a JOIN outbox o ON o.id = a.outbox_id
      WHERE o.project_id = ${scope.projectId} AND ${outboxCheckout} IN (${theseCheckouts})
      ORDER BY a.created_at, a.id`),
  ]);

  const steps = new Map<string, TraceStep[]>(ids.map((id) => [id, []]));
  const add = (checkoutId: string | null, step: TraceStep) => {
    if (checkoutId) steps.get(checkoutId)?.push(step);
  };
  for (const row of checkoutRowsFound) {
    add(row.id, { kind: "checkout_created", at: iso(row.created_at) });
    if (row.capture_requested_at) add(row.id, { kind: "capture_requested", at: iso(row.capture_requested_at) });
  }
  for (const row of events.rows) {
    add(row.checkout_id, {
      kind: "event",
      at: iso(row.received_at),
      eventType: row.event_type,
      status: row.status,
      attempts: row.attempts,
      failureCode: row.failure_code,
    });
  }
  for (const row of effects.rows) {
    add(row.checkout_id, { kind: "effect", at: iso(row.created_at), effect: row.kind, paypalPaymentId: row.paypal_payment_id });
  }
  for (const row of grants.rows) {
    add(row.checkout_id, { kind: "grant", at: iso(row.created_at), grantId: row.id, accessKey: row.access_key, status: row.status });
  }
  for (const row of outboxRows.rows) {
    add(row.checkout_id, {
      kind: "outbox",
      at: iso(row.created_at),
      outboxId: row.id,
      entityType: row.entity_type,
      sourceVersion: row.source_version,
      status: row.status,
      attempts: row.attempts,
      failureCode: row.failure_code,
    });
  }
  for (const row of attempts.rows) {
    add(row.checkout_id, {
      kind: "sync_attempt",
      at: iso(row.created_at),
      outboxId: row.outbox_id,
      entityType: row.entity_type,
      sourceVersion: row.source_version,
      outcome: row.outcome,
      code: row.code,
      durationMs: row.duration_ms,
    });
  }

  const byTime = (a: TraceStep, b: TraceStep) => a.at.localeCompare(b.at) || STEP_ORDER[a.kind] - STEP_ORDER[b.kind];
  return {
    externalCustomerId,
    checkouts: checkoutRowsFound
      .map((row) => ({ ...toCheckout(row), steps: steps.get(row.id)!.sort(byTime) }))
      .reverse(),
  };
}

export type DashboardSubscription = {
  id: string;
  checkoutId: string;
  externalCustomerId: string;
  productRef: string;
  status: SubscriptionStatus;
  reviewReason: SubscriptionReviewReason | null;
  paidThrough: string | null;
  accessUntil: string | null;
  cancelRequested: boolean;
  createdAt: string;
};

/** Every subscription a buyer started, newest first. Pending ones never approved are shown too, so they can be told apart. */
export async function listDashboardSubscriptions(
  scope: ProjectScope,
  filters: { status?: SubscriptionStatus },
  page: DashboardPage,
): Promise<DashboardPageOf<DashboardSubscription>> {
  const where = and([
    sql`s.project_id = ${scope.projectId}`,
    sql`s.environment = ${scope.environment}`,
    ...(filters.status ? [sql`s.status = ${filters.status}`] : []),
  ]);
  const db = getDb();
  const [{ rows }, { rows: counted }] = await Promise.all([
    db.execute<{
      id: string;
      checkout_id: string;
      external_customer_id: string;
      product_ref: string;
      status: SubscriptionStatus;
      review_reason: SubscriptionReviewReason | null;
      paid_through: string | null;
      cancel_requested_at: string | null;
      created_at: string;
    }>(sql`
      SELECT s.id, s.checkout_id, cu.external_customer_id, s.product_ref, s.status, s.review_reason, s.paid_through, s.cancel_requested_at, s.created_at
      FROM subscription s JOIN customer cu ON cu.id = s.customer_id
      WHERE ${where}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ${page.limit} OFFSET ${page.offset}`),
    db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM subscription s WHERE ${where}`),
  ]);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      checkoutId: row.checkout_id,
      externalCustomerId: row.external_customer_id,
      productRef: row.product_ref,
      status: row.status,
      reviewReason: row.review_reason,
      paidThrough: isoOrNull(row.paid_through),
      accessUntil: row.paid_through ? accessUntil(new Date(row.paid_through)).toISOString() : null,
      cancelRequested: row.cancel_requested_at !== null,
      createdAt: iso(row.created_at),
    })),
    total: counted[0]!.total,
  };
}

export type DashboardCredit = {
  accountId: string;
  externalCustomerId: string;
  monthly: number;
  packs: number;
  total: number;
  restricted: number;
  monthlyEndsAt: string | null;
  updatedAt: string;
};

/** Each customer's credits now: spendable by bucket, and what a refund locked. The same rule spending uses. */
export async function listDashboardCredits(scope: ProjectScope, page: DashboardPage): Promise<DashboardPageOf<DashboardCredit>> {
  const where = sql`a.project_id = ${scope.projectId} AND a.environment = ${scope.environment}`;
  const db = getDb();
  const [{ rows }, { rows: counted }] = await Promise.all([
    db.execute<{ id: string; external_customer_id: string; monthly: string; packs: string; restricted: string; monthly_ends_at: string | null; updated_at: string }>(sql`
      SELECT a.id, cu.external_customer_id, a.updated_at, l.monthly, l.packs, l.restricted, l.monthly_ends_at
      FROM credit_account a
      JOIN customer cu ON cu.id = a.customer_id
      CROSS JOIN LATERAL (
        SELECT coalesce(sum(remaining) FILTER (WHERE bucket = 'monthly' AND status = 'active' AND expires_at > now()), 0) AS monthly,
               coalesce(sum(remaining) FILTER (WHERE bucket = 'pack' AND status = 'active'), 0) AS packs,
               coalesce(sum(remaining) FILTER (WHERE status = 'restricted'), 0) AS restricted,
               max(expires_at) FILTER (WHERE bucket = 'monthly' AND status = 'active' AND remaining > 0 AND expires_at > now()) AS monthly_ends_at
        FROM credit_lot WHERE account_id = a.id
      ) l
      WHERE ${where}
      ORDER BY a.updated_at DESC, a.id DESC
      LIMIT ${page.limit} OFFSET ${page.offset}`),
    db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM credit_account a WHERE ${where}`),
  ]);
  return {
    rows: rows.map((row) => ({
      accountId: row.id,
      externalCustomerId: row.external_customer_id,
      monthly: Number(row.monthly),
      packs: Number(row.packs),
      total: Number(row.monthly) + Number(row.packs),
      restricted: Number(row.restricted),
      monthlyEndsAt: isoOrNull(row.monthly_ends_at),
      updatedAt: iso(row.updated_at),
    })),
    total: counted[0]!.total,
  };
}

/** The last week per product, for the flow canvas: how far checkouts got, and whether their copies arrived. */
export async function getProductActivity(scope: ProjectScope, days = 7): Promise<Record<string, ProductActivity>> {
  const { rows } = await getDb().execute<{ ref: string; started: number; paid: number; unresolved: number; refunded: number; applied: number; delivered: number; failed: number; active: number }>(sql`
    SELECT r.ref, r.started, r.paid, r.unresolved, r.refunded, r.applied, r.delivered, r.failed,
           (SELECT count(*)::int FROM subscription s WHERE s.project_id = ${scope.projectId} AND s.environment = ${scope.environment}
              AND s.product_ref = r.ref AND s.status = 'active') AS active
    FROM (
      SELECT c.snapshot->'product'->>'ref' AS ref,
             count(*)::int AS started,
             count(*) FILTER (WHERE c.money_status = 'captured')::int AS paid,
             count(*) FILTER (WHERE c.money_status = 'unresolved')::int AS unresolved,
             count(*) FILTER (WHERE c.money_status = 'refund_review')::int AS refunded,
             count(*) FILTER (WHERE c.fulfillment_status = 'applied')::int AS applied,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM outbox o WHERE o.entity_type = 'checkout' AND o.entity_id = c.id)
                              AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.entity_type = 'checkout' AND o.entity_id = c.id AND o.status <> 'delivered'))::int AS delivered,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM outbox o WHERE o.entity_id = c.id AND o.status = 'failed'))::int AS failed
      FROM checkout c
      WHERE c.project_id = ${scope.projectId} AND c.environment = ${scope.environment} AND c.created_at > now() - make_interval(days => ${days})
      GROUP BY 1
    ) r`);
  return Object.fromEntries(
    rows.map((row) => [
      row.ref,
      { started: row.started, paid: row.paid, unresolved: row.unresolved, refunded: row.refunded, applied: row.applied, delivered: row.delivered, failedDeliveries: row.failed, activeSubscriptions: row.active },
    ]),
  );
}
