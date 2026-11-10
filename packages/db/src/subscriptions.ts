import type { MoneyReason } from "@billingrelay/core/checkouts";
import { accessUntil, type SubscriptionReviewReason, type SubscriptionStatus } from "@billingrelay/core/subscriptions";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { getDb } from "./client";
import { grantCredits } from "./credits";
import type { ProjectScope } from "./schema";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Runner = Pick<Tx, "execute">;

// A buyer who hasn't approved yet: look again this often, while PayPal's approval link can still be used.
const PENDING_CHECK_SECONDS = 15 * 60;
const PENDING_LOOK_HOURS = 3;
const FIRST_PAYMENT_CHECK_SECONDS = 120;
// How long a claimed subscription is left alone while one worker asks PayPal about it.
const LEASE_SECONDS = 120;

const addOutboxRow = (tx: Runner, row: { projectId: string; entityType: "checkout" | "access_grant" | "subscription"; entityId: string; sourceVersion: number }) =>
  tx.execute(sql`
    INSERT INTO outbox (id, project_id, entity_type, entity_id, source_version)
    VALUES (${uuidv7()}, ${row.projectId}, ${row.entityType}, ${row.entityId}, ${row.sourceVersion})`);

export type PlanKey = { connectionId: string; productRef: string; variantRef: string; amount: number; currency: string };

export async function findPaypalPlan(key: PlanKey): Promise<string | null> {
  const { rows } = await getDb().execute<{ paypal_plan_id: string }>(sql`
    SELECT paypal_plan_id FROM paypal_plan
    WHERE connection_id = ${key.connectionId} AND product_ref = ${key.productRef} AND variant_ref = ${key.variantRef}
      AND amount = ${key.amount} AND currency = ${key.currency}`);
  return rows[0]?.paypal_plan_id ?? null;
}

/** The first plan stored for a price stays, so two first buyers at once end up on the same plan. */
export async function savePaypalPlan(key: PlanKey, ids: { productId: string; planId: string }): Promise<string> {
  await getDb().execute(sql`
    INSERT INTO paypal_plan (id, connection_id, product_ref, variant_ref, amount, currency, paypal_product_id, paypal_plan_id)
    VALUES (${uuidv7()}, ${key.connectionId}, ${key.productRef}, ${key.variantRef}, ${key.amount}, ${key.currency}, ${ids.productId}, ${ids.planId})
    ON CONFLICT (connection_id, product_ref, variant_ref, amount, currency) DO NOTHING`);
  return (await findPaypalPlan(key))!;
}

export type SubscriptionRecord = {
  id: string;
  projectId: string;
  environment: "sandbox" | "live";
  checkoutId: string;
  productRef: string;
  paypalPlanId: string;
  paypalSubscriptionId: string;
  status: SubscriptionStatus;
  reviewReason: SubscriptionReviewReason | null;
  paidThrough: Date | null;
  accessUntil: Date | null;
  nextBillingTime: Date | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
};

type SubscriptionRow = {
  id: string;
  project_id: string;
  environment: "sandbox" | "live";
  checkout_id: string;
  product_ref: string;
  paypal_plan_id: string;
  paypal_subscription_id: string;
  status: SubscriptionStatus;
  review_reason: SubscriptionReviewReason | null;
  paid_through: string | null;
  next_billing_time: string | null;
  cancel_requested_at: string | null;
  created_at: string;
};

const date = (value: string | null) => (value === null ? null : new Date(value));

const toRecord = (row: SubscriptionRow): SubscriptionRecord => ({
  id: row.id,
  projectId: row.project_id,
  environment: row.environment,
  checkoutId: row.checkout_id,
  productRef: row.product_ref,
  paypalPlanId: row.paypal_plan_id,
  paypalSubscriptionId: row.paypal_subscription_id,
  status: row.status,
  reviewReason: row.review_reason,
  paidThrough: date(row.paid_through),
  accessUntil: row.paid_through === null ? null : accessUntil(new Date(row.paid_through)),
  nextBillingTime: date(row.next_billing_time),
  cancelRequestedAt: date(row.cancel_requested_at),
  createdAt: new Date(row.created_at),
});

const selectSubscription = (where: ReturnType<typeof sql>) => sql`
  SELECT id, project_id, environment, checkout_id, product_ref, paypal_plan_id, paypal_subscription_id, status, review_reason,
         paid_through, next_billing_time, cancel_requested_at, created_at
  FROM subscription WHERE ${where}`;

async function findOne(where: ReturnType<typeof sql>): Promise<SubscriptionRecord | null> {
  const { rows } = await getDb().execute<SubscriptionRow>(selectSubscription(where));
  return rows[0] ? toRecord(rows[0]) : null;
}

export const findSubscription = (id: string) => findOne(sql`id = ${id}`);
export const findSubscriptionByCheckout = (checkoutId: string) => findOne(sql`checkout_id = ${checkoutId}`);

export const getSubscription = ({ projectId, environment }: ProjectScope, id: string) =>
  findOne(sql`project_id = ${projectId} AND environment = ${environment} AND id = ${id}`);

/** A verified event's subscription, only inside the project whose webhook received it. Our checkout ID is checked too when PayPal sends it. */
export async function findSubscriptionForEvent(
  { projectId, environment }: ProjectScope,
  reference: { paypalSubscriptionId: string | null; checkoutId: string | null },
): Promise<SubscriptionRecord | null> {
  if (reference.paypalSubscriptionId) {
    return findOne(sql`project_id = ${projectId} AND environment = ${environment} AND paypal_subscription_id = ${reference.paypalSubscriptionId}`);
  }
  if (reference.checkoutId) return findOne(sql`project_id = ${projectId} AND environment = ${environment} AND checkout_id = ${reference.checkoutId}`);
  return null;
}

/** The checkout's one PayPal subscription. A slower request that made the same one (same request ID) finds this row. */
export async function saveSubscription(values: { checkoutId: string; paypalPlanId: string; paypalSubscriptionId: string }): Promise<SubscriptionRecord> {
  await getDb().execute(sql`
    INSERT INTO subscription (id, project_id, environment, customer_id, checkout_id, product_ref, paypal_plan_id, paypal_subscription_id, next_check_at)
    SELECT ${uuidv7()}, project_id, environment, customer_id, id, snapshot->'product'->>'ref', ${values.paypalPlanId}, ${values.paypalSubscriptionId},
           now() + make_interval(secs => ${PENDING_CHECK_SECONDS})
    FROM checkout WHERE id = ${values.checkoutId}
    ON CONFLICT (checkout_id) DO NOTHING`);
  return (await findSubscriptionByCheckout(values.checkoutId))!;
}

/** Whether a sale an event named has been stored: PayPal's transaction list can lag behind its own sale event. */
export async function isSaleRecorded(paypalSaleId: string): Promise<boolean> {
  const { rows } = await getDb().execute(sql`SELECT 1 FROM subscription_payment WHERE paypal_sale_id = ${paypalSaleId}`);
  return rows.length > 0;
}

export async function markCancelRequested(id: string): Promise<void> {
  await getDb().execute(sql`UPDATE subscription SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now() WHERE id = ${id}`);
}

/** One due subscription, pushed back for the lease first, so a crash just means asking again later. Sandbox only. */
export async function claimSubscriptionForCheck(): Promise<string | null> {
  const { rows } = await getDb().execute<{ id: string }>(sql`
    UPDATE subscription
    SET next_check_at = now() + make_interval(secs => ${LEASE_SECONDS})
    WHERE id = (
      SELECT id FROM subscription
      WHERE environment = 'sandbox' AND next_check_at <= now()
      ORDER BY next_check_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`);
  return rows[0]?.id ?? null;
}

export type SubscriptionPaymentRead = {
  paypalSaleId: string;
  amount: number | null;
  currency: string;
  paidAt: Date;
  // `counts`, or why it doesn't pay for a period.
  outcome: "counts" | SubscriptionReviewReason;
};

export type SubscriptionRead = {
  status: SubscriptionStatus;
  // The buyer approved at PayPal, whether or not its first payment has gone through yet.
  approved: boolean;
  nextBillingTime: Date | null;
  // The subscription itself isn't the one we created: none of its payments count.
  mismatch: SubscriptionReviewReason | null;
  payments: SubscriptionPaymentRead[];
  nextCheckAt: Date | null;
};

type LockedRow = {
  id: string;
  project_id: string;
  environment: string;
  customer_id: string;
  checkout_id: string;
  status: SubscriptionStatus;
  review_reason: SubscriptionReviewReason | null;
  paid_through: string | null;
  next_billing_time: string | null;
  checkout_created_at: string;
  access_key: string | null;
  monthly_credits: number | null;
};

const MONEY_REASON_FOR: Record<SubscriptionReviewReason, MoneyReason> = {
  reference_mismatch: "reference_mismatch",
  plan_mismatch: "reference_mismatch",
  amount_mismatch: "amount_mismatch",
  currency_mismatch: "currency_mismatch",
};

/**
 * What PayPal said, applied once, in one transaction with the outbox rows. The row lock puts the buyer's return, events and
 * the worker one after another; the unique sale ID means a payment seen twice is stored once and pays for one period.
 */
export async function recordSubscriptionState(id: string, read: SubscriptionRead): Promise<void> {
  await getDb().transaction(async (tx) => {
    const { rows } = await tx.execute<LockedRow>(sql`
      SELECT s.id, s.project_id, s.environment, s.customer_id, s.checkout_id, s.status, s.review_reason, s.paid_through, s.next_billing_time,
             c.created_at AS checkout_created_at,
             (SELECT b->>'key' FROM json_array_elements(c.snapshot->'benefits') b WHERE b->>'kind' = 'access' LIMIT 1) AS access_key,
             (SELECT (b->>'amount')::bigint FROM json_array_elements(c.snapshot->'benefits') b WHERE b->>'kind' = 'credits' LIMIT 1) AS monthly_credits
      FROM subscription s JOIN checkout c ON c.id = s.checkout_id
      WHERE s.id = ${id}
      FOR UPDATE OF s`);
    const locked = rows[0];
    if (!locked) return;

    const inserted: SubscriptionPaymentRead[] = [];
    for (const payment of read.payments) {
      const outcome = read.mismatch ?? payment.outcome;
      const { rows: added } = await tx.execute(sql`
        INSERT INTO subscription_payment (id, subscription_id, paypal_sale_id, amount, currency, paid_at, outcome)
        VALUES (${uuidv7()}, ${id}, ${payment.paypalSaleId}, ${payment.amount}, ${payment.currency}, ${payment.paidAt.toISOString()}, ${outcome})
        ON CONFLICT (paypal_sale_id) DO NOTHING
        RETURNING id`);
      if (added.length > 0) inserted.push({ ...payment, outcome });
    }

    const counted = inserted.filter((payment) => payment.outcome === "counts");
    const problems = inserted.flatMap((payment) => (payment.outcome === "counts" ? [] : [payment.outcome]));
    const firstProblem = read.mismatch ?? problems[0] ?? null;
    const reviewReason = locked.review_reason ?? firstProblem;

    // A counted payment pays until PayPal's next billing time. Never backwards: a stale read can't shorten paid time.
    let paidThrough = locked.paid_through ? new Date(locked.paid_through) : null;
    if (counted.length > 0 && reviewReason === null) {
      const latest = counted.reduce((a, b) => (a.paidAt > b.paidAt ? a : b));
      const until = read.nextBillingTime && read.nextBillingTime > latest.paidAt ? read.nextBillingTime : addMonth(latest.paidAt);
      if (!paidThrough || until > paidThrough) paidThrough = until;
    }

    const status = read.status;
    const nextBillingTime = read.nextBillingTime ?? date(locked.next_billing_time);
    // Approved but no payment recorded yet: PayPal is still taking the first one, or its list hasn't caught up. Look again soon,
    // not a month from now.
    const awaitingFirstPayment = read.approved && status !== "pending" && status !== "expired" && paidThrough === null && reviewReason === null;
    const nextCheckAt =
      status === "pending"
        ? nextPendingCheck(new Date(locked.checkout_created_at))
        : awaitingFirstPayment
          ? new Date(Date.now() + FIRST_PAYMENT_CHECK_SECONDS * 1000)
          : read.nextCheckAt;

    const paidThroughChanged = (paidThrough?.getTime() ?? null) !== (locked.paid_through ? new Date(locked.paid_through).getTime() : null);
    const changed =
      status !== locked.status ||
      reviewReason !== locked.review_reason ||
      paidThroughChanged ||
      (nextBillingTime?.getTime() ?? null) !== (date(locked.next_billing_time)?.getTime() ?? null);

    const { rows: saved } = await tx.execute<{ source_version: number }>(sql`
      UPDATE subscription
      SET status = ${status}, review_reason = ${reviewReason}, paid_through = ${paidThrough?.toISOString() ?? null},
          next_billing_time = ${nextBillingTime?.toISOString() ?? null}, next_check_at = ${nextCheckAt?.toISOString() ?? null},
          source_version = source_version + ${changed ? 1 : 0}, updated_at = CASE WHEN ${changed} THEN now() ELSE updated_at END
      WHERE id = ${id}
      RETURNING source_version`);
    if (changed) await addOutboxRow(tx, { projectId: locked.project_id, entityType: "subscription", entityId: id, sourceVersion: saved[0]!.source_version });

    if (paidThroughChanged && paidThrough && locked.access_key) {
      await extendAccess(tx, locked, paidThrough, counted[0]!.paypalSaleId);
    }
    // This month's credits, from the payment that paid for it. They end with the access; the last month's end now.
    if (paidThroughChanged && paidThrough && locked.monthly_credits) {
      const latest = counted.reduce((a, b) => (a.paidAt > b.paidAt ? a : b));
      await grantCredits(tx, {
        projectId: locked.project_id,
        environment: locked.environment,
        customerId: locked.customer_id,
        paypalPaymentId: latest.paypalSaleId,
        bucket: "monthly",
        amount: Number(locked.monthly_credits),
        expiresAt: accessUntil(paidThrough),
        checkoutId: locked.checkout_id,
        subscriptionId: locked.id,
      });
    }
    await settleCheckout(tx, locked, { firstCounted: counted[0] ?? null, problem: firstProblem, approved: read.approved });
  });
}

/** A buyer who hasn't approved: looked at every 15 minutes while PayPal's approval link can still be used, then left to events. */
function nextPendingCheck(checkoutCreatedAt: Date): Date | null {
  const next = new Date(Date.now() + PENDING_CHECK_SECONDS * 1000);
  return next.getTime() < checkoutCreatedAt.getTime() + PENDING_LOOK_HOURS * 3600_000 ? next : null;
}

const addMonth = (from: Date) => {
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
};

/** The subscription's one grant: made by its first counted payment, moved forward by each one after. */
async function extendAccess(tx: Tx, locked: LockedRow, paidThrough: Date, firstSaleId: string): Promise<void> {
  const activeUntil = accessUntil(paidThrough).toISOString();
  const { rows } = await tx.execute<{ id: string; source_version: number }>(sql`
    INSERT INTO access_grant (id, project_id, environment, customer_id, access_key, checkout_id, paypal_payment_id, subscription_id, active_until)
    VALUES (${uuidv7()}, ${locked.project_id}, ${locked.environment}, ${locked.customer_id}, ${locked.access_key}, ${locked.checkout_id},
            ${firstSaleId}, ${locked.id}, ${activeUntil})
    ON CONFLICT (subscription_id) DO UPDATE
    SET active_until = EXCLUDED.active_until, source_version = access_grant.source_version + 1, updated_at = now()
    WHERE access_grant.active_until IS DISTINCT FROM EXCLUDED.active_until
    RETURNING id, source_version`);
  const grant = rows[0];
  if (grant) await addOutboxRow(tx, { projectId: locked.project_id, entityType: "access_grant", entityId: grant.id, sourceVersion: grant.source_version });
}

/**
 * The start checkout says what its first payment did: `captured` with its benefits applied, or a mismatch for a person.
 * Only from `pending` or `approved`, so it's set once. A late approval still counts: PayPal took the money when the buyer approved.
 * Approved with no payment yet is `approved`, so the buyer's page keeps waiting instead of offering to pay again. Its
 * `capture_requested_at` marks that PayPal may take money now, so the checkout can never read as expired.
 */
async function settleCheckout(
  tx: Tx,
  locked: LockedRow,
  { firstCounted, problem, approved }: { firstCounted: SubscriptionPaymentRead | null; problem: SubscriptionReviewReason | null; approved: boolean },
): Promise<void> {
  if (!firstCounted && !problem && !approved) return;
  const { rows } = await tx.execute<{ source_version: number }>(
    !firstCounted && !problem
      ? sql`
        UPDATE checkout
        SET money_status = 'approved', capture_requested_at = COALESCE(capture_requested_at, now()),
            source_version = source_version + 1, updated_at = now()
        WHERE id = ${locked.checkout_id} AND money_status = 'pending'
        RETURNING source_version`
      : problem
      ? sql`
        UPDATE checkout
        SET money_status = 'unresolved', money_reason = ${MONEY_REASON_FOR[problem]}, capture_requested_at = COALESCE(capture_requested_at, now()),
            source_version = source_version + 1, updated_at = now()
        WHERE id = ${locked.checkout_id} AND money_status IN ('pending', 'approved')
        RETURNING source_version`
      : sql`
        UPDATE checkout
        SET money_status = 'captured', money_reason = NULL, paypal_capture_id = ${firstCounted!.paypalSaleId},
            capture_requested_at = COALESCE(capture_requested_at, now()),
            captured_amount = ${firstCounted!.amount}, captured_currency = ${firstCounted!.currency},
            fulfillment_status = 'applied', source_version = source_version + 1, updated_at = now()
        WHERE id = ${locked.checkout_id} AND money_status IN ('pending', 'approved')
        RETURNING source_version`,
  );
  const changed = rows[0];
  if (changed) await addOutboxRow(tx, { projectId: locked.project_id, entityType: "checkout", entityId: locked.checkout_id, sourceVersion: changed.source_version });
}
