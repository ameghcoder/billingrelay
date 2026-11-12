import { isSettled } from "@billingrelay/core/checkouts";
import {
  applyCheckoutBenefits,
  findCheckout,
  findCheckoutForEvent,
  findSubscriptionForEvent,
  isSaleRecorded,
  restrictRefundedCheckout,
  type CheckoutRecord,
  type ClaimedPaypalEvent,
} from "@billingrelay/db";
import { readEvent, type PaypalEventFacts } from "@billingrelay/provider-paypal";
import { z } from "zod";
import { confirmPayment } from "./payments";
import { syncSubscription } from "./subscriptions";

export type EventOutcome = { status: "processed" | "ignored" } | { status: "retry"; code: string };

const PROCESSED: EventOutcome = { status: "processed" };
const IGNORED: EventOutcome = { status: "ignored" };
const retry = (code: string): EventOutcome => ({ status: "retry", code });

const applyIfCaptured = async (checkout: CheckoutRecord) => {
  if (checkout.moneyStatus === "captured") await applyCheckoutBenefits(checkout.id);
};

/** Our own IDs are UUIDs, and PayPal repeats whatever `custom_id` an order on this app was given, ours or not. */
const ourCheckoutId = (checkoutId: string | null) => (z.uuid().safeParse(checkoutId).success ? checkoutId : null);

const asCheckoutReference = ({ checkoutId, orderId }: PaypalEventFacts) => ({
  checkoutId: ourCheckoutId(checkoutId),
  orderId: checkoutId === null ? orderId : null,
});

/** Any subscription event: ask PayPal for the subscription and its payments. The event's own amounts are never used. */
async function handleSubscriptionEvent(scope: ClaimedPaypalEvent["scope"], facts: PaypalEventFacts): Promise<EventOutcome> {
  const checkoutId = ourCheckoutId(facts.checkoutId);
  const subscription = await findSubscriptionForEvent(scope, { paypalSubscriptionId: facts.subscriptionId, checkoutId });
  if (!subscription) {
    // Ours, but the row isn't stored yet (PayPal answered and the save hasn't committed): look again shortly.
    // A one-time checkout never gets a subscription row, so waiting for one would only fail later.
    const ours = checkoutId && (await findCheckoutForEvent(scope, { checkoutId, orderId: null }));
    return ours && ours.snapshot.product.kind === "subscription" ? retry("subscription_not_recorded") : IGNORED;
  }
  const { unknown } = await syncSubscription(subscription);
  if (unknown) return retry("paypal_unavailable");
  // PayPal's transaction list can lag its own sale event. Until the sale is stored, the event isn't done.
  if (facts.captureId && !(await isSaleRecorded(facts.captureId))) return retry("sale_not_listed_yet");
  return PROCESSED;
}

async function handleRefund(checkout: CheckoutRecord, captureId: string | null): Promise<EventOutcome> {
  if (checkout.moneyStatus === "captured") {
    // A refund of a capture we never recorded isn't explained by anything here, so it stays visible.
    if (!captureId || captureId !== checkout.paypalCaptureId) return retry("refund_capture_mismatch");
    await restrictRefundedCheckout(checkout.id, captureId);
    return PROCESSED;
  }
  // Already in review, or it never granted anything and a person is looking at it. Otherwise the capture isn't recorded yet.
  return isSettled(checkout) ? PROCESSED : retry("capture_not_recorded");
}

/**
 * An event is a nudge, not the fact acted on: it only says which checkout to ask PayPal about. Repeats and
 * events out of order can't matter, and `confirmPayment` stays the one path that can say `captured`.
 * Money and benefits are separate transactions, so a failure applying benefits can't hide that the money arrived.
 */
export async function handleEvent({ eventType, payload, scope }: ClaimedPaypalEvent): Promise<EventOutcome> {
  if (scope.environment !== "sandbox") return IGNORED;
  const facts = readEvent(eventType, payload);
  if (facts.signal === "other") return IGNORED;
  if (facts.signal === "subscription_changed") return handleSubscriptionEvent(scope, facts);

  const found = await findCheckoutForEvent(scope, asCheckoutReference(facts));
  if (!found) return IGNORED;

  const { checkout, unknown } = await confirmPayment(found);
  if (unknown) return retry("paypal_unavailable");

  if (facts.signal === "capture_refunded") return handleRefund(checkout, facts.captureId);
  // PayPal told us it's approved, so its read may just be behind. Treating this as done would strand a buyer who never returns.
  if (facts.signal === "order_approved" && checkout.moneyStatus === "pending" && !isSettled(checkout)) return retry("order_not_approved_yet");

  await applyIfCaptured(checkout);
  return PROCESSED;
}

/** Asks PayPal again about a capture whose outcome isn't known, with no event involved. */
export async function recheckPayment(checkoutId: string): Promise<void> {
  const found = await findCheckout(checkoutId);
  if (!found) return;
  const { checkout } = await confirmPayment(found);
  await applyIfCaptured(checkout);
}
