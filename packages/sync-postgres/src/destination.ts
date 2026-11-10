import type { AccessProjection, CreditBalanceProjection, Projection, PurchaseProjection, SubscriptionProjection } from "@billingrelay/core/sync";
import pg from "pg";
import { classifyDestinationError, type DestinationFailure } from "./errors";
import { destinationUrlProblem } from "./tls";

/** The version of `migrations/` this code writes to. The worker delivers nothing to any other. */
export const SCHEMA_VERSION = 3;

const POOL_SETTINGS = {
  max: 2,
  connectionTimeoutMillis: 3_000,
  // A destination that hangs gives up quickly. It never holds a payment up: sync has its own queue.
  // The server cancels first, so a statement stuck behind a lock doesn't outlive the connection we dropped.
  statement_timeout: 4_000,
  query_timeout: 5_000,
  application_name: "billingrelay-sync",
} satisfies pg.PoolConfig;

export type Destination = { pool: pg.Pool };

/** No URL: sync is off. A URL we won't use is a setup problem, reported without connecting. */
export function openDestination(url: string | undefined): Destination | { problem: string } | null {
  if (!url) return null;
  const problem = destinationUrlProblem(url);
  if (problem) return { problem };
  const pool = new pg.Pool({ ...POOL_SETTINGS, connectionString: url });
  // Without a listener, an idle connection dropping crashes the process. Only the code: the text can name the host.
  pool.on("error", (error) => console.error(`destination pool error: ${classifyDestinationError(error).code}`));
  return { pool };
}

/** Null when it's safe to write. Refuses a role that could create or drop things, so a mistake here can't damage the merchant's database. */
export async function checkDestination({ pool }: Destination): Promise<DestinationFailure | null> {
  try {
    const { rows } = await pool.query<{ version: number | null; can_create: boolean }>(`
      SELECT (SELECT max(version) FROM billingrelay.schema_version) AS version,
             has_schema_privilege('billingrelay', 'CREATE') OR has_database_privilege(current_database(), 'CREATE') AS can_create`);
    const row = rows[0];
    if (row?.version !== SCHEMA_VERSION) return { kind: "not_ready", code: "schema_version_mismatch" };
    if (row.can_create) return { kind: "not_ready", code: "role_too_powerful" };
    return null;
  } catch (error) {
    return classifyDestinationError(error);
  }
}

const upsertPurchase = (row: PurchaseProjection) => ({
  text: `
    INSERT INTO billingrelay.purchases AS p
      (project_id, checkout_id, environment, customer_id, external_customer_id, product_ref, product_name, product_kind, variant_ref,
       quantity, amount, currency, money_status, fulfillment_status, paypal_capture_id, metadata, expires_at, created_at,
       source_version, source_updated_at, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20, now())
    ON CONFLICT (project_id, checkout_id) DO UPDATE
    SET money_status = EXCLUDED.money_status, fulfillment_status = EXCLUDED.fulfillment_status,
        paypal_capture_id = EXCLUDED.paypal_capture_id, source_version = EXCLUDED.source_version,
        source_updated_at = EXCLUDED.source_updated_at, synced_at = now()
    WHERE EXCLUDED.source_version > p.source_version
    RETURNING 1`,
  values: [
    row.projectId, row.checkoutId, row.environment, row.customerId, row.externalCustomerId, row.productRef, row.productName, row.productKind,
    row.variantRef, row.quantity, row.amount, row.currency, row.moneyStatus, row.fulfillmentStatus, row.paypalCaptureId,
    JSON.stringify(row.metadata), row.expiresAt, row.createdAt, row.sourceVersion, row.sourceUpdatedAt,
  ],
});

const upsertAccess = (row: AccessProjection) => ({
  text: `
    INSERT INTO billingrelay.access AS a
      (project_id, grant_id, environment, customer_id, external_customer_id, access_key, checkout_id, status,
       source_version, source_updated_at, active_until, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
    ON CONFLICT (project_id, grant_id) DO UPDATE
    SET status = EXCLUDED.status, active_until = EXCLUDED.active_until, source_version = EXCLUDED.source_version,
        source_updated_at = EXCLUDED.source_updated_at, synced_at = now()
    WHERE EXCLUDED.source_version > a.source_version
    RETURNING 1`,
  values: [
    row.projectId, row.grantId, row.environment, row.customerId, row.externalCustomerId, row.accessKey, row.checkoutId, row.status,
    row.sourceVersion, row.sourceUpdatedAt, row.activeUntil,
  ],
});

const upsertSubscription = (row: SubscriptionProjection) => ({
  text: `
    INSERT INTO billingrelay.subscriptions AS s
      (project_id, subscription_id, environment, customer_id, external_customer_id, checkout_id, product_ref, status, review_reason,
       paid_through, access_until, cancel_requested, paypal_subscription_id, source_version, source_updated_at, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
    ON CONFLICT (project_id, subscription_id) DO UPDATE
    SET status = EXCLUDED.status, review_reason = EXCLUDED.review_reason, paid_through = EXCLUDED.paid_through,
        access_until = EXCLUDED.access_until, cancel_requested = EXCLUDED.cancel_requested,
        source_version = EXCLUDED.source_version, source_updated_at = EXCLUDED.source_updated_at, synced_at = now()
    WHERE EXCLUDED.source_version > s.source_version
    RETURNING 1`,
  values: [
    row.projectId, row.subscriptionId, row.environment, row.customerId, row.externalCustomerId, row.checkoutId, row.productRef, row.status,
    row.reviewReason, row.paidThrough, row.accessUntil, row.cancelRequested, row.paypalSubscriptionId, row.sourceVersion, row.sourceUpdatedAt,
  ],
});

const upsertBalance = (row: CreditBalanceProjection) => ({
  text: `
    INSERT INTO billingrelay.credit_balances AS b
      (project_id, account_id, environment, customer_id, external_customer_id, monthly, packs, total, monthly_ends_at,
       source_version, source_updated_at, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
    ON CONFLICT (project_id, account_id) DO UPDATE
    SET monthly = EXCLUDED.monthly, packs = EXCLUDED.packs, total = EXCLUDED.total, monthly_ends_at = EXCLUDED.monthly_ends_at,
        source_version = EXCLUDED.source_version, source_updated_at = EXCLUDED.source_updated_at, synced_at = now()
    WHERE EXCLUDED.source_version > b.source_version
    RETURNING 1`,
  values: [
    row.projectId, row.accountId, row.environment, row.customerId, row.externalCustomerId, row.monthly, row.packs, row.total, row.monthlyEndsAt,
    row.sourceVersion, row.sourceUpdatedAt,
  ],
});

const upsertFor = (projection: Projection) => {
  if (projection.entityType === "checkout") return upsertPurchase(projection.row);
  if (projection.entityType === "access_grant") return upsertAccess(projection.row);
  if (projection.entityType === "subscription") return upsertSubscription(projection.row);
  return upsertBalance(projection.row);
};

/**
 * One transaction. `unchanged` means the destination already had this version or newer: a repeat, a late job,
 * or another worker that got there first. Only a version that's newer ever changes a row.
 */
export async function deliver({ pool }: Destination, projection: Projection): Promise<"delivered" | "unchanged"> {
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query("BEGIN");
    const { row } = projection;
    await client.query(
      `INSERT INTO billingrelay.customers (project_id, customer_id, external_customer_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [row.projectId, row.customerId, row.externalCustomerId],
    );
    const result = await client.query(upsertFor(projection));
    await client.query("COMMIT");
    return result.rowCount ? "delivered" : "unchanged";
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A connection that failed mid-transaction is thrown away; the server rolls back what it had.
    client.release(failed);
  }
}

export async function closeDestination({ pool }: Destination): Promise<void> {
  await pool.end();
}
