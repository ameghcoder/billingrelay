import { createHash } from "node:crypto";
import { findSubscriptionMismatch, judgeSubscriptionPayment, nextSubscriptionCheck, statusForStage } from "@billingrelay/core/subscriptions";
import {
  findCheckout,
  findPaypalPlan,
  findSubscription,
  findSubscriptionByCheckout,
  getPaypalConnection,
  markCancelRequested,
  recordSubscriptionState,
  savePaypalPlan,
  saveSubscription,
  type CheckoutRecord,
  type PlanKey,
  type SubscriptionRecord,
} from "@billingrelay/db";
import {
  cancelSubscription,
  createMonthlyPlan,
  createSubscription,
  getSubscription,
  listSubscriptionPayments,
  PaypalError,
  type PaypalSession,
} from "@billingrelay/provider-paypal";
import type { ConfirmResult, StartResult } from "./payments";
import { sessionFor } from "./session";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The plan for this checkout's price, made at PayPal the first time anyone buys at that price. */
async function planFor(checkout: CheckoutRecord, session: PaypalSession): Promise<string> {
  const connection = await getPaypalConnection(checkout.projectId, checkout.environment);
  if (!connection) throw new PaypalError("unavailable", "not_connected");
  const { snapshot } = checkout;
  const key: PlanKey = {
    connectionId: connection.id,
    productRef: snapshot.product.ref,
    variantRef: snapshot.variant?.ref ?? "",
    amount: snapshot.unitAmount,
    currency: snapshot.currency,
  };
  const stored = await findPaypalPlan(key);
  if (stored) return stored;
  // Two first buyers at once may both make a plan; the first one stored is used, and the other is never sold.
  const requestKey = createHash("sha256").update(Object.values(key).join("\0")).digest("hex").slice(0, 40);
  const ids = await createMonthlyPlan(session, {
    requestKey,
    productName: snapshot.product.name,
    planName: [snapshot.product.name, snapshot.variant?.name].filter(Boolean).join(" · "),
    amount: snapshot.unitAmount,
    currency: snapshot.currency,
  });
  return savePaypalPlan(key, ids);
}

/** Asks PayPal about the subscription and its payments, then stores what that means. Safe to repeat from anywhere. */
async function syncWith(session: PaypalSession, subscription: SubscriptionRecord, checkout: CheckoutRecord): Promise<void> {
  const read = await getSubscription(session, subscription.paypalSubscriptionId);
  const expected = {
    checkoutId: checkout.id,
    planId: subscription.paypalPlanId,
    amount: checkout.snapshot.unitAmount,
    currency: checkout.snapshot.currency,
  };
  // Nothing is charged before approval, so there's nothing to list.
  const paid = read.stage === "waiting_for_buyer" ? [] : await listSubscriptionPayments(session, read.id, new Date(subscription.createdAt.getTime() - DAY_MS), new Date(Date.now() + DAY_MS));
  const payments = paid.flatMap((payment) => {
    const outcome = judgeSubscriptionPayment(expected, payment);
    if (outcome === "not_completed") return [];
    return [{ paypalSaleId: payment.id, amount: payment.amount, currency: payment.currency, paidAt: payment.paidAt, outcome }];
  });
  await recordSubscriptionState(subscription.id, {
    status: statusForStage(read.stage, subscription.status),
    approved: read.stage !== "waiting_for_buyer",
    nextBillingTime: read.nextBillingTime,
    mismatch: findSubscriptionMismatch(expected, read),
    payments,
    nextCheckAt: nextSubscriptionCheck(read.nextBillingTime, new Date()),
  });
}

/** `unknown`: PayPal gave no usable answer this time. Throws anything that isn't PayPal's. */
export async function syncSubscription(subscription: SubscriptionRecord): Promise<{ unknown: boolean }> {
  const checkout = await findCheckout(subscription.checkoutId);
  if (!checkout) throw new Error("Subscription without its checkout");
  try {
    await syncWith(await sessionFor(subscription), subscription, checkout);
    return { unknown: false };
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    console.warn(`PayPal subscription read failed: ${error.message}`);
    return { unknown: true };
  }
}

export async function recheckSubscription(id: string): Promise<void> {
  const subscription = await findSubscription(id);
  if (subscription) await syncSubscription(subscription);
}

/** The buyer's return, or an event that names this checkout. No subscription yet means nothing was started at PayPal. */
export async function confirmSubscription(checkout: CheckoutRecord): Promise<ConfirmResult> {
  const subscription = await findSubscriptionByCheckout(checkout.id);
  if (!subscription) return { checkout, unknown: false };
  const { unknown } = await syncSubscription(subscription);
  return { checkout: (await findCheckout(checkout.id))!, unknown };
}

/** Makes the checkout's one PayPal subscription, or reuses it. Throws a PaypalError if PayPal says no or can't be reached. */
export async function startSubscription(checkout: CheckoutRecord, origin: string | null): Promise<StartResult> {
  const session = await sessionFor(checkout);
  const existing = await findSubscriptionByCheckout(checkout.id);
  if (existing) return continueSubscription(session, existing, checkout);

  if (!origin) throw new PaypalError("unavailable", "public_url_invalid");
  const planId = await planFor(checkout, session);
  const created = await createSubscription(session, {
    requestId: `subscription-${checkout.id}`,
    planId,
    customId: checkout.id,
    returnUrl: `${origin}/checkout/${checkout.id}/return`,
    cancelUrl: `${origin}/checkout/${checkout.id}?cancelled=1`,
  });
  const saved = await saveSubscription({ checkoutId: checkout.id, paypalPlanId: planId, paypalSubscriptionId: created.id });
  // Never hand out an approval link for a subscription that isn't this checkout's one subscription.
  if (saved.paypalSubscriptionId !== created.id) return continueSubscription(session, saved, checkout);
  if (!created.approvalUrl) throw new PaypalError("unavailable", "no_approval_link");
  return { approvalUrl: created.approvalUrl };
}

async function continueSubscription(session: PaypalSession, subscription: SubscriptionRecord, checkout: CheckoutRecord): Promise<StartResult> {
  const read = await getSubscription(session, subscription.paypalSubscriptionId);
  if (read.stage === "waiting_for_buyer" && read.approvalUrl) return { approvalUrl: read.approvalUrl };
  await syncWith(session, subscription, checkout);
  return { checkout: (await findCheckout(checkout.id))!, unknown: false };
}

/** Stops renewals at PayPal, then reads what PayPal says. Paid time stays: access runs to `paidThrough` plus the grace. */
export async function cancelSubscriptionAtPaypal(subscription: SubscriptionRecord): Promise<{ unknown: boolean }> {
  await markCancelRequested(subscription.id);
  if (subscription.status !== "cancelled" && subscription.status !== "expired") {
    try {
      await cancelSubscription(await sessionFor(subscription), subscription.paypalSubscriptionId);
    } catch (error) {
      if (!(error instanceof PaypalError)) throw error;
      console.warn(`PayPal subscription cancel failed: ${error.message}`);
      return { unknown: true };
    }
  }
  return syncSubscription(subscription);
}
