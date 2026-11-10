import { checkoutResponseSchema, isSettled, nextActionFor, showMoneyStatus, type CheckoutResponse, type PublicCheckout } from "@billingrelay/core/checkouts";
import { findSubscriptionByCheckout, getCheckoutSync, type CheckoutRecord } from "@billingrelay/db";
import { toSubscriptionSummary } from "./subscription";
import { publicOrigin } from "./paypal-connection";

export const checkoutUrlFor = (id: string) => `${publicOrigin() ?? ""}/checkout/${id}`;

/** What the merchant's backend sees. `sync` comes from the outbox, so it never needs the destination itself. */
export async function toCheckoutResponse(checkout: CheckoutRecord): Promise<CheckoutResponse> {
  const money = showMoneyStatus(checkout);
  const sync = await getCheckoutSync(checkout.id);
  const subscription = checkout.snapshot.product.kind === "subscription" ? await findSubscriptionByCheckout(checkout.id) : null;
  return checkoutResponseSchema.parse({
    id: checkout.id,
    externalCustomerId: checkout.externalCustomerId,
    checkoutUrl: checkoutUrlFor(checkout.id),
    expiresAt: checkout.expiresAt.toISOString(),
    money,
    fulfillment: checkout.fulfillmentStatus,
    sync,
    nextAction: nextActionFor(money),
    snapshot: checkout.snapshot,
    paypal: { orderId: checkout.paypalOrderId, captureId: checkout.paypalCaptureId },
    subscription: subscription && toSubscriptionSummary(subscription),
  });
}

function backUrlFor(checkout: CheckoutRecord): string {
  const url = new URL(checkout.returnUrl);
  url.searchParams.set("checkout", checkout.id);
  return url.toString();
}

export function toPublicCheckout(checkout: CheckoutRecord): PublicCheckout {
  const money = showMoneyStatus(checkout);
  return { money, nextAction: nextActionFor(money), settled: isSettled(checkout), backUrl: backUrlFor(checkout) };
}
