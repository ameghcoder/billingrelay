import type { MoneyReason, StoredMoneyStatus } from "@billingrelay/core/checkouts";
import type { QuoteSnapshot } from "@billingrelay/core/quotes";
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";
import { getDb } from "./client";
import { ensureCustomer } from "./customers";
import { checkout, customer, type ProjectScope } from "./schema";

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
};

const selectCheckouts = <Columns extends typeof checkoutColumns>(columns: Columns) =>
  getDb().select(columns).from(checkout).innerJoin(customer, eq(customer.id, checkout.customerId));

const inScope = ({ projectId, environment }: ProjectScope) => and(eq(checkout.projectId, projectId), eq(checkout.environment, environment));

/** For the hosted page, whose only credential is holding the link. */
export async function findCheckout(id: string): Promise<CheckoutRecord | null> {
  const [row] = await selectCheckouts(checkoutColumns).where(eq(checkout.id, id));
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

/**
 * Stores the customer (if new) and the checkout together. Returns null if this key or this quote
 * is already taken, and rolls back so a new customer in this request leaves no row behind.
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
): Promise<string | null> {
  const { projectId, externalCustomerId, lifetimeSeconds, ...row } = values;
  try {
    return await getDb().transaction(async (tx) => {
      const customerId = await ensureCustomer(tx, projectId, externalCustomerId);
      const [created] = await tx
        .insert(checkout)
        .values({ ...row, projectId, customerId, expiresAt: sql`now() + make_interval(secs => ${lifetimeSeconds})` })
        // No target: either unique rule, the key or the quote, means this request lost.
        .onConflictDoNothing()
        .returning({ id: checkout.id });
      if (!created) return tx.rollback();
      return created.id;
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) return null;
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

/** Called before PayPal is asked to capture. The first time stays, so a retry can't move it. */
export async function markCaptureRequested(id: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE checkout
    SET capture_requested_at = COALESCE(capture_requested_at, now()),
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
  // The WHERE lists the only states that may still change, so a slow request can't overwrite captured, failed or a mismatch.
  await getDb().execute(sql`
    UPDATE checkout
    SET money_status = ${moneyStatus},
        money_reason = ${moneyReason},
        paypal_capture_id = COALESCE(${capture?.id ?? null}, paypal_capture_id),
        captured_amount = COALESCE(${capture?.amount ?? null}, captured_amount),
        captured_currency = COALESCE(${capture?.currency ?? null}, captured_currency),
        updated_at = now()
    WHERE id = ${id}
      AND (money_status IN ('pending', 'approved')
           OR (money_status = 'unresolved' AND money_reason = 'capture_outcome_unknown'))`);
  return (await findCheckout(id))!;
}
