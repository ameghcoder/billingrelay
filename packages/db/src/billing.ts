import type { BillingResponse } from "@billingrelay/core/credits";
import { accessUntil } from "@billingrelay/core/subscriptions";
import { sql } from "drizzle-orm";
import { getDb } from "./client";
import { getCustomerBalance } from "./credits";
import type { ProjectScope } from "./schema";

const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());

/** One customer's billing as it is now: access, subscriptions, paid purchases and credits. Null for a customer we've never seen. */
export async function getCustomerBilling(scope: ProjectScope, externalCustomerId: string): Promise<BillingResponse | null> {
  const db = getDb();
  const { rows: customers } = await db.execute<{ id: string }>(sql`
    SELECT id FROM customer WHERE project_id = ${scope.projectId} AND external_customer_id = ${externalCustomerId}`);
  const customerId = customers[0]?.id;
  if (!customerId) return null;
  const inScope = sql`project_id = ${scope.projectId} AND environment = ${scope.environment} AND customer_id = ${customerId}`;

  const [grants, subscriptions, purchases, versions, credits] = await Promise.all([
    db.execute<{ access_key: string; status: "active" | "restricted"; active_until: string | null; checkout_id: string; active_now: boolean }>(sql`
      SELECT access_key, status, active_until, checkout_id,
             (status = 'active' AND (active_until IS NULL OR active_until > now())) AS active_now
      FROM access_grant WHERE ${inScope} ORDER BY created_at`),
    db.execute<{ id: string; status: string; review_reason: string | null; paid_through: string | null; cancel_requested_at: string | null; product_ref: string; checkout_id: string }>(sql`
      SELECT id, status, review_reason, paid_through, cancel_requested_at, product_ref, checkout_id
      FROM subscription WHERE ${inScope} AND status <> 'pending' ORDER BY created_at`),
    // Only purchases where money moved: an open or abandoned checkout isn't a purchase.
    db.execute<{ id: string; product_ref: string; product_kind: string; amount: string; currency: string; money_status: string; fulfillment_status: string; created_at: string }>(sql`
      SELECT id, snapshot->'product'->>'ref' AS product_ref, snapshot->'product'->>'kind' AS product_kind, (snapshot->>'amount')::bigint AS amount,
             snapshot->>'currency' AS currency, money_status, fulfillment_status, created_at
      FROM checkout WHERE ${inScope} AND money_status IN ('captured', 'refund_review', 'unresolved') ORDER BY created_at`),
    db.execute<{ version: string }>(sql`
      SELECT (SELECT coalesce(sum(source_version), 0) FROM checkout WHERE ${inScope})
           + (SELECT coalesce(sum(source_version), 0) FROM access_grant WHERE ${inScope})
           + (SELECT coalesce(sum(source_version), 0) FROM subscription WHERE ${inScope}) AS version`),
    getCustomerBalance(scope, customerId),
  ]);

  return {
    externalCustomerId,
    version: Number(versions.rows[0]!.version) + credits.version,
    access: grants.rows.map((grant) => ({
      key: grant.access_key,
      active: grant.active_now,
      status: grant.status,
      activeUntil: iso(grant.active_until),
      checkoutId: grant.checkout_id,
    })),
    subscriptions: subscriptions.rows.map((subscription) => ({
      id: subscription.id,
      productRef: subscription.product_ref,
      checkoutId: subscription.checkout_id,
      status: subscription.status as BillingResponse["subscriptions"][number]["status"],
      reviewReason: subscription.review_reason as BillingResponse["subscriptions"][number]["reviewReason"],
      paidThrough: iso(subscription.paid_through),
      accessUntil: subscription.paid_through ? accessUntil(new Date(subscription.paid_through)).toISOString() : null,
      cancelRequested: subscription.cancel_requested_at !== null,
    })),
    purchases: purchases.rows.map((purchase) => ({
      checkoutId: purchase.id,
      productRef: purchase.product_ref,
      productKind: purchase.product_kind,
      amount: Number(purchase.amount),
      currency: purchase.currency,
      money: purchase.money_status,
      fulfillment: purchase.fulfillment_status,
      createdAt: new Date(purchase.created_at).toISOString(),
    })),
    credits: credits.balance,
  };
}
