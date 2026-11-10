import type { FulfillmentReason, FulfillmentStatus, MoneyReason, StoredMoneyStatus } from "@billingrelay/core/checkouts";
import type { QuoteSnapshot } from "@billingrelay/core/quotes";
import { and, eq, sql, TransactionRollbackError, type SQL } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { getDb } from "./client";
import { ensureCustomer } from "./customers";
import { retryDelay } from "./retry-delay";
import { checkout, customer, type ProjectScope } from "./schema";

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

const FIRST_CHECK_AFTER_CAPTURE_SECONDS = 30;
// 5s, 30s, 2m, 10m, then hourly: about 24 hours.
const MAX_UNCLEAR_CHECKS = 28;
// 5s, 30s, 2m, 10m, then hourly: enough to cover the rest of a checkout's hour.
const MAX_UNCONFIRMED_CHECKS = 5;

export type CheckoutRecord = {
  id: string;
  projectId: string;
  environment: "sandbox" | "live";
  externalCustomerId: string;
  quoteId: string | null;
  returnUrl: string;
  snapshot: QuoteSnapshot;
  expiresAt: Date;
  isExpired: boolean;
  moneyStatus: StoredMoneyStatus;
  moneyReason: MoneyReason | null;
  captureRequestedAt: Date | null;
  paypalOrderId: string | null;
  paypalSellerId: string | null;
  paypalCaptureId: string | null;
  fulfillmentStatus: FulfillmentStatus;
  fulfillmentReason: FulfillmentReason | null;
};

const checkoutColumns = {
  id: checkout.id,
  projectId: checkout.projectId,
  environment: checkout.environment,
  externalCustomerId: customer.externalCustomerId,
  quoteId: checkout.quoteId,
  returnUrl: checkout.returnUrl,
  snapshot: checkout.snapshot,
  expiresAt: checkout.expiresAt,
  // The database's clock, so the web server's clock can't change the answer.
  isExpired: sql<boolean>`${checkout.expiresAt} <= now()`,
  moneyStatus: checkout.moneyStatus,
  moneyReason: checkout.moneyReason,
  captureRequestedAt: checkout.captureRequestedAt,
  paypalOrderId: checkout.paypalOrderId,
  paypalSellerId: checkout.paypalSellerId,
  paypalCaptureId: checkout.paypalCaptureId,
  fulfillmentStatus: checkout.fulfillmentStatus,
  fulfillmentReason: checkout.fulfillmentReason,
};

const selectCheckouts = <Columns extends typeof checkoutColumns>(columns: Columns) =>
  getDb().select(columns).from(checkout).innerJoin(customer, eq(customer.id, checkout.customerId));

const inScope = ({ projectId, environment }: ProjectScope) => and(eq(checkout.projectId, projectId), eq(checkout.environment, environment));

/** For the hosted page, whose only credential is holding the link. */
export async function findCheckout(id: string): Promise<CheckoutRecord | null> {
  const [row] = await selectCheckouts(checkoutColumns).where(eq(checkout.id, id));
  return row ?? null;
}

/** A verified event's checkout, only inside the project whose webhook received it. */
export async function findCheckoutForEvent(scope: ProjectScope, reference: { checkoutId: string | null; orderId: string | null }): Promise<CheckoutRecord | null> {
  const match = reference.checkoutId ? eq(checkout.id, reference.checkoutId) : reference.orderId ? eq(checkout.paypalOrderId, reference.orderId) : null;
  if (!match) return null;
  const [row] = await selectCheckouts(checkoutColumns).where(and(inScope(scope), match));
  return row ?? null;
}

export async function getCheckout(scope: ProjectScope, id: string): Promise<CheckoutRecord | null> {
  const [row] = await selectCheckouts(checkoutColumns).where(and(inScope(scope), eq(checkout.id, id)));
  return row ?? null;
}

export async function findCheckoutByKey(scope: ProjectScope, idempotencyKey: string): Promise<(CheckoutRecord & { payloadHash: string }) | null> {
  const [row] = await selectCheckouts({ ...checkoutColumns, payloadHash: checkout.payloadHash }).where(
    and(inScope(scope), eq(checkout.idempotencyKey, idempotencyKey)),
  );
  return row ?? null;
}

export async function findCheckoutIdByQuote(scope: ProjectScope, quoteId: string): Promise<string | null> {
  const [row] = await getDb().select({ id: checkout.id }).from(checkout).where(and(inScope(scope), eq(checkout.quoteId, quoteId)));
  return row?.id ?? null;
}

export type CreateCheckoutResult = { status: "created"; id: string } | { status: "taken" } | { status: "subscription_exists"; checkoutId: string };

/**
 * A subscription this customer already pays for, or is starting, for the same product. Cancelled, expired or
 * left unapproved past its hour, it no longer counts. Runs with the customer's row locked.
 */
async function findWantedSubscription(tx: Transaction, customerId: string, productRef: string): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT c.id FROM checkout c
    LEFT JOIN subscription s ON s.checkout_id = c.id
    WHERE c.customer_id = ${customerId}
      AND c.snapshot->'product'->>'kind' = 'subscription'
      AND c.snapshot->'product'->>'ref' = ${productRef}
      AND (s.status IN ('active', 'suspended')
           OR (COALESCE(s.status, 'pending') = 'pending' AND c.money_status IN ('pending', 'approved') AND c.expires_at > now()))
    ORDER BY c.created_at DESC
    LIMIT 1`);
  return rows[0]?.id ?? null;
}

/**
 * Stores the customer (if new) and the checkout together. `taken` if this key or this quote is already used, and
 * rolls back so a new customer in this request leaves no row behind. A subscription locks the customer's row, so two
 * requests at once can't both start one.
 */
export async function createCheckout(
  values: ProjectScope & {
    apiKeyId: string;
    externalCustomerId: string;
    quoteId: string | null;
    idempotencyKey: string;
    payloadHash: string;
    returnUrl: string;
    snapshot: QuoteSnapshot;
    lifetimeSeconds: number;
  },
): Promise<CreateCheckoutResult> {
  const { projectId, externalCustomerId, lifetimeSeconds, ...row } = values;
  try {
    return await getDb().transaction(async (tx): Promise<CreateCheckoutResult> => {
      const customerId = await ensureCustomer(tx, projectId, externalCustomerId);
      if (row.snapshot.product.kind === "subscription") {
        await tx.execute(sql`SELECT id FROM customer WHERE id = ${customerId} FOR UPDATE`);
        const existing = await findWantedSubscription(tx, customerId, row.snapshot.product.ref);
        if (existing) return { status: "subscription_exists", checkoutId: existing };
      }
      const [created] = await tx
        .insert(checkout)
        .values({ ...row, projectId, customerId, expiresAt: sql`now() + make_interval(secs => ${lifetimeSeconds})` })
        // No target: either unique rule, the key or the quote, means this request lost.
        .onConflictDoNothing()
        .returning({ id: checkout.id });
      if (!created) return tx.rollback();
      return { status: "created", id: created.id };
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) return { status: "taken" };
    throw error;
  }
}

/** One checkout keeps its first order, whatever a slower request comes back with. */
export async function saveCheckoutOrder(id: string, orderId: string, sellerId: string | null): Promise<CheckoutRecord> {
  await getDb().execute(sql`
    UPDATE checkout
    SET paypal_order_id = COALESCE(paypal_order_id, ${orderId}),
        paypal_seller_id = CASE WHEN paypal_order_id IS NULL THEN ${sellerId} ELSE paypal_seller_id END,
        updated_at = now()
    WHERE id = ${id}`);
  return (await findCheckout(id))!;
}

/**
 * Called before PayPal is asked to capture. The first time stays, so a retry can't move it.
 * The worker's first look waits a moment, so it doesn't repeat a capture that's still on its way.
 */
export async function markCaptureRequested(id: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE checkout
    SET capture_requested_at = COALESCE(capture_requested_at, now()),
        next_check_at = COALESCE(next_check_at, now() + make_interval(secs => ${FIRST_CHECK_AFTER_CAPTURE_SECONDS})),
        updated_at = now()
    WHERE id = ${id}`);
}

export async function recordCheckoutMoney(
  id: string,
  outcome: {
    moneyStatus: "approved" | "captured" | "failed" | "unresolved";
    moneyReason: MoneyReason | null;
    capture?: { id: string; amount: number | null; currency: string } | null;
  },
): Promise<CheckoutRecord> {
  const { moneyStatus, moneyReason, capture } = outcome;
  const captureId = capture?.id ?? null;
  const amount = capture?.amount ?? null;
  const currency = capture?.currency ?? null;
  // One statement, so the change and its outbox row commit together. The first half of the WHERE lists the only
  // states that may still change, so a slow request can't overwrite captured, failed or a mismatch. The second
  // half skips a repeat of what's already stored, so 20 confirms make one outbox row, not 20.
  await getDb().execute(sql`
    WITH changed AS (
      UPDATE checkout
      SET money_status = ${moneyStatus},
          money_reason = ${moneyReason},
          paypal_capture_id = COALESCE(${captureId}, paypal_capture_id),
          captured_amount = COALESCE(${amount}, captured_amount),
          captured_currency = COALESCE(${currency}, captured_currency),
          source_version = source_version + 1,
          next_check_at = NULL,
          check_attempts = 0,
          updated_at = now()
      WHERE id = ${id}
        AND (money_status IN ('pending', 'approved')
             OR (money_status = 'unresolved' AND money_reason = 'capture_outcome_unknown'))
        AND (money_status IS DISTINCT FROM ${moneyStatus}
             OR money_reason IS DISTINCT FROM ${moneyReason}
             OR paypal_capture_id IS DISTINCT FROM COALESCE(${captureId}, paypal_capture_id)
             OR captured_amount IS DISTINCT FROM COALESCE(${amount}, captured_amount)
             OR captured_currency IS DISTINCT FROM COALESCE(${currency}, captured_currency))
      RETURNING id, project_id, source_version
    )
    INSERT INTO outbox (id, project_id, entity_type, entity_id, source_version)
    SELECT ${uuidv7()}, project_id, 'checkout', id, source_version FROM changed`);
  return (await findCheckout(id))!;
}

/** Claiming pushes the next look back first, so a crash mid-way just means trying again later. Sandbox only. */
const claimCheckout = async (needsWork: SQL): Promise<string | null> => {
  const { rows } = await getDb().execute<{ id: string }>(sql`
    UPDATE checkout
    SET check_attempts = check_attempts + 1,
        next_check_at = now() + ${retryDelay(sql`check_attempts + 1`)}
    WHERE id = (
      SELECT id FROM checkout
      WHERE environment = 'sandbox'
        AND fulfillment_status = 'pending'
        AND (next_check_at IS NULL OR next_check_at <= now())
        AND ${needsWork}
      ORDER BY next_check_at NULLS FIRST, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`);
  return rows[0]?.id ?? null;
};

/** Money arrived and its benefits haven't been applied: the buyer's own confirm, or a crash between the two steps. */
export const claimCheckoutForBenefits = () =>
  claimCheckout(sql`
    money_status = 'captured' AND snapshot->'product'->>'kind' <> 'subscription'
    AND (fulfillment_reason IS NULL OR fulfillment_reason = 'waiting_for_credit_ledger')`);

/**
 * Reconciliation: an order the buyer may have approved, with no event and no return. Asked about a few times while the checkout's
 * hour lasts, through the same confirm path as the buyer's own return, which never captures after that hour.
 */
export const claimUnconfirmedOrder = () =>
  claimCheckout(sql`
    money_status = 'pending' AND paypal_order_id IS NOT NULL AND capture_requested_at IS NULL
    AND created_at < now() - interval '5 minutes' AND expires_at > now() AND check_attempts < ${MAX_UNCONFIRMED_CHECKS}`);

/** A capture was sent and its outcome isn't known. Gives up after about a day, and stays visible for a person. */
export const claimUnclearCheckout = () =>
  claimCheckout(sql`
    check_attempts < ${MAX_UNCLEAR_CHECKS}
    AND paypal_order_id IS NOT NULL
    AND ((money_status = 'unresolved' AND money_reason = 'capture_outcome_unknown')
         OR (money_status = 'approved' AND capture_requested_at IS NOT NULL))`);
