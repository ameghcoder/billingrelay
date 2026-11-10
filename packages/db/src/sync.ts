import { accessUntil } from "@billingrelay/core/subscriptions";
import type { CheckoutSyncStatus, DestinationState, Projection, SyncEntityType, SyncOutcome, SyncStatusResponse } from "@billingrelay/core/sync";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { getDb } from "./client";
import { readBalance } from "./credits";
import { retryDelay } from "./retry-delay";

const MAX_ATTEMPTS = 8;
// Longer than one delivery can take: connecting and each query stop after a few seconds.
const LEASE_SECONDS = 60;
const RECENT_ATTEMPTS = 20;

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Runner = Pick<Tx, "execute">;

const addAttempt = (db: Runner, attempt: { outboxId: string | null; outcome: SyncOutcome; code?: string | null; durationMs?: number | null }) =>
  db.execute(sql`
    INSERT INTO sync_attempt (id, outbox_id, outcome, code, duration_ms)
    VALUES (${uuidv7()}, ${attempt.outboxId}, ${attempt.outcome}, ${attempt.code ?? null}, ${attempt.durationMs ?? null})`);

export type ClaimedOutboxRow = { id: string; entityType: SyncEntityType; entityId: string };

/** Same as events: one due row for the length of the lease, committed at once, so no source lock is held while the destination is written. */
export async function claimOutboxRow(): Promise<ClaimedOutboxRow | null> {
  const { rows } = await getDb().execute<{ id: string; entity_type: SyncEntityType; entity_id: string }>(sql`
    UPDATE outbox
    SET attempts = attempts + 1,
        next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
    WHERE id = (
      SELECT id FROM outbox
      WHERE status = 'pending' AND next_attempt_at <= now() AND attempts < ${MAX_ATTEMPTS}
      ORDER BY next_attempt_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, entity_type, entity_id`);
  const row = rows[0];
  return row ? { id: row.id, entityType: row.entity_type, entityId: row.entity_id } : null;
}

type PurchaseRow = {
  project_id: string;
  customer_id: string;
  external_customer_id: string;
  checkout_id: string;
  environment: string;
  product_ref: string;
  product_name: string;
  product_kind: string;
  variant_ref: string | null;
  quantity: number;
  amount: string;
  currency: string;
  money_status: string;
  fulfillment_status: string;
  paypal_capture_id: string | null;
  metadata: Record<string, string>;
  expires_at: string;
  created_at: string;
  source_version: number;
  updated_at: string;
};

type AccessRow = {
  project_id: string;
  customer_id: string;
  external_customer_id: string;
  grant_id: string;
  environment: string;
  access_key: string;
  checkout_id: string;
  status: string;
  active_until: string | null;
  source_version: number;
  updated_at: string;
};

type SubscriptionRow = {
  project_id: string;
  customer_id: string;
  external_customer_id: string;
  subscription_id: string;
  environment: string;
  checkout_id: string;
  product_ref: string;
  status: string;
  review_reason: string | null;
  paid_through: string | null;
  cancel_requested_at: string | null;
  paypal_subscription_id: string;
  source_version: number;
  updated_at: string;
};

async function loadSubscriptionProjection(entityId: string): Promise<Projection | null> {
  const { rows } = await getDb().execute<SubscriptionRow>(sql`
    SELECT s.project_id, s.customer_id, cu.external_customer_id, s.id AS subscription_id, s.environment, s.checkout_id, s.product_ref,
           s.status, s.review_reason, s.paid_through, s.cancel_requested_at, s.paypal_subscription_id, s.source_version, s.updated_at
    FROM subscription s JOIN customer cu ON cu.id = s.customer_id
    WHERE s.id = ${entityId}`);
  const row = rows[0];
  if (!row) return null;
  const paidThrough = row.paid_through ? new Date(row.paid_through) : null;
  return {
    entityType: "subscription",
    row: {
      projectId: row.project_id,
      customerId: row.customer_id,
      externalCustomerId: row.external_customer_id,
      subscriptionId: row.subscription_id,
      environment: row.environment,
      checkoutId: row.checkout_id,
      productRef: row.product_ref,
      status: row.status,
      reviewReason: row.review_reason,
      paidThrough,
      accessUntil: paidThrough && accessUntil(paidThrough),
      cancelRequested: row.cancel_requested_at !== null,
      paypalSubscriptionId: row.paypal_subscription_id,
      sourceVersion: row.source_version,
      sourceUpdatedAt: new Date(row.updated_at),
    },
  };
}

/** The balance as it is now, worked out the same way spending sees it. A copy of a balance, never credits added up there. */
async function loadCreditProjection(entityId: string): Promise<Projection | null> {
  const { rows } = await getDb().execute<{ project_id: string; customer_id: string; external_customer_id: string; environment: string; source_version: number; updated_at: string }>(sql`
    SELECT a.project_id, a.customer_id, cu.external_customer_id, a.environment, a.source_version, a.updated_at
    FROM credit_account a JOIN customer cu ON cu.id = a.customer_id
    WHERE a.id = ${entityId}`);
  const row = rows[0];
  if (!row) return null;
  const balance = await readBalance(getDb(), entityId);
  return {
    entityType: "credit_account",
    row: {
      projectId: row.project_id,
      customerId: row.customer_id,
      externalCustomerId: row.external_customer_id,
      accountId: entityId,
      environment: row.environment,
      monthly: balance.monthly,
      packs: balance.packs,
      total: balance.total,
      monthlyEndsAt: balance.monthlyEndsAt ? new Date(balance.monthlyEndsAt) : null,
      sourceVersion: row.source_version,
      sourceUpdatedAt: new Date(row.updated_at),
    },
  };
}

/** The record as it is now, not as it was when the row was written: one delivery covers every change before it. */
export async function loadProjection(entityType: SyncEntityType, entityId: string): Promise<Projection | null> {
  if (entityType === "subscription") return loadSubscriptionProjection(entityId);
  if (entityType === "credit_account") return loadCreditProjection(entityId);
  if (entityType === "checkout") {
    const { rows } = await getDb().execute<PurchaseRow>(sql`
      SELECT c.project_id, c.customer_id, cu.external_customer_id, c.id AS checkout_id, c.environment,
             c.snapshot->'product'->>'ref' AS product_ref, c.snapshot->'product'->>'name' AS product_name,
             c.snapshot->'product'->>'kind' AS product_kind, c.snapshot->'variant'->>'ref' AS variant_ref,
             (c.snapshot->>'quantity')::int AS quantity, (c.snapshot->>'amount')::bigint AS amount, c.snapshot->>'currency' AS currency,
             c.money_status, c.fulfillment_status, c.paypal_capture_id, c.snapshot->'metadata' AS metadata,
             c.expires_at, c.created_at, c.source_version, c.updated_at
      FROM checkout c JOIN customer cu ON cu.id = c.customer_id
      WHERE c.id = ${entityId}`);
    const row = rows[0];
    if (!row) return null;
    return {
      entityType,
      row: {
        projectId: row.project_id,
        customerId: row.customer_id,
        externalCustomerId: row.external_customer_id,
        checkoutId: row.checkout_id,
        environment: row.environment,
        productRef: row.product_ref,
        productName: row.product_name,
        productKind: row.product_kind,
        variantRef: row.variant_ref,
        quantity: row.quantity,
        amount: Number(row.amount),
        currency: row.currency,
        moneyStatus: row.money_status,
        fulfillmentStatus: row.fulfillment_status,
        paypalCaptureId: row.paypal_capture_id,
        metadata: row.metadata ?? {},
        expiresAt: new Date(row.expires_at),
        createdAt: new Date(row.created_at),
        sourceVersion: row.source_version,
        sourceUpdatedAt: new Date(row.updated_at),
      },
    };
  }

  const { rows } = await getDb().execute<AccessRow>(sql`
    SELECT g.project_id, g.customer_id, cu.external_customer_id, g.id AS grant_id, g.environment, g.access_key,
           g.checkout_id, g.status, g.active_until, g.source_version, g.updated_at
    FROM access_grant g JOIN customer cu ON cu.id = g.customer_id
    WHERE g.id = ${entityId}`);
  const row = rows[0];
  if (!row) return null;
  return {
    entityType,
    row: {
      projectId: row.project_id,
      customerId: row.customer_id,
      externalCustomerId: row.external_customer_id,
      grantId: row.grant_id,
      environment: row.environment,
      accessKey: row.access_key,
      checkoutId: row.checkout_id,
      status: row.status,
      activeUntil: row.active_until ? new Date(row.active_until) : null,
      sourceVersion: row.source_version,
      sourceUpdatedAt: new Date(row.updated_at),
    },
  };
}

/**
 * The destination has this version or a newer one, so every waiting row for the record up to it is done.
 * Called only after the destination committed. A crash before this just delivers again, and the destination says "not newer".
 */
export async function recordDelivered(
  claimed: ClaimedOutboxRow,
  delivered: { sourceVersion: number; outcome: "delivered" | "unchanged"; durationMs: number },
): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE outbox
      SET status = 'delivered', delivered_at = now(), failure_code = NULL
      WHERE entity_type = ${claimed.entityType} AND entity_id = ${claimed.entityId}
        AND source_version <= ${delivered.sourceVersion} AND status <> 'delivered'`);
    await addAttempt(tx, { outboxId: claimed.id, outcome: delivered.outcome, durationMs: delivered.durationMs });
    await tx.execute(sql`UPDATE sync_status SET last_delivered_at = now(), updated_at = now() WHERE id = 1`);
  });
}

/** This row was refused. It waits longer each time, then stays visible as `failed`. Other rows aren't held up. */
export async function retryOutboxRow(id: string, code: string, durationMs: number | null): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE outbox
      SET failure_code = ${code},
          status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
          next_attempt_at = now() + ${retryDelay(sql`attempts`)}
      WHERE id = ${id} AND status = 'pending'`);
    await addAttempt(tx, { outboxId: id, outcome: "refused", code, durationMs });
  });
}

/** The destination failed, not this row: give back the attempt the claim used, so an outage never pushes a row to `failed`. */
export async function releaseOutboxRow(id: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE outbox SET attempts = GREATEST(attempts - 1, 0), next_attempt_at = now()
    WHERE id = ${id} AND status = 'pending'`);
}

/** A worker killed on a row's last attempt can't record that itself. */
export async function failAbandonedOutboxRows(): Promise<void> {
  await getDb().execute(sql`
    UPDATE outbox
    SET status = 'failed', failure_code = COALESCE(failure_code, 'worker_died')
    WHERE status = 'pending' AND attempts >= ${MAX_ATTEMPTS} AND next_attempt_at <= now()`);
}

/** Called when a worker starts. `checking` makes the next pass look at the destination before writing anything. */
export async function startSyncStatus(start: { state: "not_configured" | "checking" | "not_ready"; code?: string }): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO sync_status (id, state, code, failures, next_try_at, down_since)
    VALUES (1, ${start.state}, ${start.code ?? null}, 0, now(), NULL)
    ON CONFLICT (id) DO UPDATE
    SET state = EXCLUDED.state, code = EXCLUDED.code, failures = 0, next_try_at = now(), updated_at = now(),
        down_since = CASE WHEN EXCLUDED.state = 'not_ready' THEN COALESCE(sync_status.down_since, now()) ELSE NULL END`);
}

export type SyncGate = { state: DestinationState; due: boolean };

export async function readSyncGate(): Promise<SyncGate> {
  const { rows } = await getDb().execute<{ state: DestinationState; due: boolean }>(sql`
    SELECT state, next_try_at <= now() AS due FROM sync_status WHERE id = 1`);
  return rows[0] ?? { state: "not_configured", due: false };
}

export async function recordDestinationOk(): Promise<void> {
  await getDb().execute(sql`
    UPDATE sync_status
    SET state = 'ok', code = NULL, failures = 0, down_since = NULL, next_try_at = now(), updated_at = now()
    WHERE id = 1`);
}

/**
 * Nothing is written to the destination until a check passes again. Waits 5s, 10s, 20s, 40s, then a minute,
 * each a little random so several workers don't all knock at once.
 */
export async function recordDestinationProblem(problem: { state: "down" | "not_ready"; code: string }): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE sync_status
      SET state = ${problem.state}, code = ${problem.code}, failures = failures + 1,
          down_since = COALESCE(down_since, now()),
          next_try_at = now() + make_interval(secs => LEAST(60, 5 * power(2, failures)) * (0.8 + random() * 0.4)),
          updated_at = now()
      WHERE id = 1`);
    await addAttempt(tx, { outboxId: null, outcome: problem.state, code: problem.code });
  });
}

/** Ends every wait now: failed rows go back to pending, and the destination is looked at on the next pass. M13 and M14 call it. */
export async function retrySyncNow(): Promise<{ requeued: number }> {
  return getDb().transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE outbox SET status = 'pending', attempts = 0, failure_code = NULL, next_attempt_at = now()
      WHERE status = 'failed'
      RETURNING id`);
    await tx.execute(sql`
      UPDATE outbox SET next_attempt_at = now()
      WHERE status = 'pending' AND next_attempt_at > now() + make_interval(secs => ${LEASE_SECONDS})`);
    await tx.execute(sql`UPDATE sync_status SET next_try_at = now(), updated_at = now() WHERE id = 1`);
    return { requeued: rows.length };
  });
}

/** The worst state across the checkout and its grants. */
export async function getCheckoutSync(checkoutId: string): Promise<CheckoutSyncStatus> {
  const { rows } = await getDb().execute<{ state: DestinationState | null; failed: number; pending: number; total: number }>(sql`
    SELECT (SELECT state FROM sync_status WHERE id = 1) AS state,
           count(*) FILTER (WHERE status = 'failed')::int AS failed,
           count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*)::int AS total
    FROM outbox
    WHERE (entity_type = 'checkout' AND entity_id = ${checkoutId})
       OR (entity_type = 'access_grant' AND entity_id IN (SELECT id FROM access_grant WHERE checkout_id = ${checkoutId}))`);
  const row = rows[0];
  if (!row || row.state === null || row.state === "not_configured") return "not_configured";
  if (row.failed > 0) return "failed";
  return row.pending > 0 || row.total === 0 ? "pending" : "delivered";
}

/** For `/api/health`, without connecting to the destination. */
export async function getDestinationState(): Promise<DestinationState> {
  return (await readSyncGate()).state;
}

const iso = (value: string | null) => (value ? new Date(value).toISOString() : null);

export async function getSyncOverview(): Promise<SyncStatusResponse> {
  const db = getDb();
  const { rows } = await db.execute<{
    state: DestinationState | null;
    code: string | null;
    down_since: string | null;
    next_try_at: string | null;
    last_delivered_at: string | null;
    pending: number;
    failed: number;
    lag_seconds: number | null;
  }>(sql`
    SELECT s.state, s.code, s.down_since, s.next_try_at, s.last_delivered_at,
           (SELECT count(*)::int FROM outbox WHERE status = 'pending') AS pending,
           (SELECT count(*)::int FROM outbox WHERE status = 'failed') AS failed,
           (SELECT extract(epoch FROM now() - min(created_at))::float8 FROM outbox WHERE status <> 'delivered') AS lag_seconds
    FROM (SELECT 1) AS one LEFT JOIN sync_status s ON s.id = 1`);
  const { rows: attempts } = await db.execute<{
    created_at: string;
    outcome: SyncOutcome;
    code: string | null;
    entity_type: string | null;
    entity_id: string | null;
    duration_ms: number | null;
  }>(sql`
    SELECT a.created_at, a.outcome, a.code, o.entity_type, o.entity_id, a.duration_ms
    FROM sync_attempt a LEFT JOIN outbox o ON o.id = a.outbox_id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${RECENT_ATTEMPTS}`);
  const status = rows[0]!;
  return {
    destination: {
      state: status.state ?? "not_configured",
      code: status.code,
      downSince: iso(status.down_since),
      nextTryAt: status.state && status.state !== "ok" ? iso(status.next_try_at) : null,
    },
    pending: status.pending,
    failed: status.failed,
    lagSeconds: status.lag_seconds === null ? null : Math.round(status.lag_seconds),
    lastDeliveredAt: iso(status.last_delivered_at),
    attempts: attempts.map((a) => ({
      at: new Date(a.created_at).toISOString(),
      outcome: a.outcome,
      code: a.code,
      entityType: a.entity_type,
      entityId: a.entity_id,
      durationMs: a.duration_ms,
    })),
  };
}
