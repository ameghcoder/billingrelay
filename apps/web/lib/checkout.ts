import {
  findOrderMismatch,
  isSettled,
  judgeCaptures,
  nextActionFor,
  showMoneyStatus,
  checkoutResponseSchema,
  type CheckoutResponse,
  type PublicCheckout,
} from "@billingrelay/core/checkouts";
import { SecretUnreadableError } from "@billingrelay/core/secrets";
import { getPaypalConnection, markCaptureRequested, recordCheckoutMoney, saveCheckoutOrder, type CheckoutRecord } from "@billingrelay/db";
import {
  captureOrder,
  captureRefusal,
  createOrder,
  getOrder,
  isOrderGone,
  PaypalError,
  type PaypalOrder,
  type PaypalSession,
} from "@billingrelay/provider-paypal";
import { openStoredSession, publicOrigin } from "./paypal-connection";

const orderRequestId = (checkoutId: string) => `order-${checkoutId}`;
const captureRequestId = (orderId: string) => `capture-${orderId}`;

const expectedFor = (checkout: CheckoutRecord) => ({
  checkoutId: checkout.id,
  amount: checkout.snapshot.amount,
  currency: checkout.snapshot.currency,
  sellerId: checkout.paypalSellerId,
});

async function sessionFor(checkout: CheckoutRecord): Promise<PaypalSession> {
  const connection = await getPaypalConnection(checkout.projectId, checkout.environment);
  if (!connection) throw new PaypalError("unavailable", "not_connected");
  try {
    return await openStoredSession(connection);
  } catch (error) {
    if (error instanceof SecretUnreadableError) throw new PaypalError("unavailable", "secret_unreadable");
    throw error;
  }
}

/** `unknown`: PayPal gave no usable answer this time, so the caller should say "still confirming". */
export type ConfirmResult = { checkout: CheckoutRecord; unknown: boolean };

const known = (checkout: CheckoutRecord): ConfirmResult => ({ checkout, unknown: false });

const recordUnknown = async (checkout: CheckoutRecord): Promise<ConfirmResult> => ({
  checkout: await recordCheckoutMoney(checkout.id, { moneyStatus: "unresolved", moneyReason: "capture_outcome_unknown" }),
  unknown: true,
});

/** The order is gone. If a capture was ever sent, that doesn't prove no money moved. */
async function orderGone(checkout: CheckoutRecord): Promise<ConfirmResult> {
  if (checkout.captureRequestedAt) return recordUnknown(checkout);
  return known(await recordCheckoutMoney(checkout.id, { moneyStatus: "failed", moneyReason: "order_gone" }));
}

const recordCaptures = async (checkout: CheckoutRecord, order: PaypalOrder): Promise<ConfirmResult> =>
  known(await recordCheckoutMoney(checkout.id, judgeCaptures(expectedFor(checkout), order.captures)));

/** PayPal just said this order is captured. If the order can't be read now, that's unknown, never "gone" or "failed". */
async function recordAlreadyCaptured(checkout: CheckoutRecord, session: PaypalSession, orderId: string): Promise<ConfirmResult> {
  try {
    return await recordCaptures(checkout, await getOrder(session, orderId));
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    console.warn(`PayPal read after capture failed: ${error.message}`);
    return recordUnknown(checkout);
  }
}

async function capture(checkout: CheckoutRecord, session: PaypalSession, order: PaypalOrder): Promise<ConfirmResult> {
  const mismatch = findOrderMismatch(expectedFor(checkout), order);
  if (mismatch) return known(await recordCheckoutMoney(checkout.id, { moneyStatus: "unresolved", moneyReason: mismatch }));

  const current = checkout.moneyStatus === "pending" ? await recordCheckoutMoney(checkout.id, { moneyStatus: "approved", moneyReason: null }) : checkout;
  // Before the call, so a crash during it can't look like "nothing happened".
  await markCaptureRequested(checkout.id);

  try {
    return await recordCaptures(current, await captureOrder(session, order.id, captureRequestId(order.id)));
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    console.warn(`PayPal capture failed: ${error.message}`);
    const refusal = captureRefusal(error);
    if (refusal === "declined") return known(await recordCheckoutMoney(checkout.id, { moneyStatus: "failed", moneyReason: "paypal_declined" }));
    if (refusal === "already_captured") return recordAlreadyCaptured(current, session, order.id);
    return recordUnknown(current);
  }
}

function actOnOrder(checkout: CheckoutRecord, session: PaypalSession, order: PaypalOrder): Promise<ConfirmResult> {
  if (order.stage === "approved") return capture(checkout, session, order);
  if (order.stage === "completed") return recordCaptures(checkout, order);
  if (order.stage === "voided") return orderGone(checkout);
  // Waiting for the buyer: a redirect alone proves nothing, so nothing changes.
  return Promise.resolve({ checkout, unknown: order.stage !== "waiting_for_buyer" });
}

/** Read, check, capture, check. Safe to repeat from anywhere: the same order is only ever captured once. */
export async function confirmPayment(checkout: CheckoutRecord): Promise<ConfirmResult> {
  if (isSettled(checkout) || !checkout.paypalOrderId) return known(checkout);
  try {
    const session = await sessionFor(checkout);
    const order = await getOrder(session, checkout.paypalOrderId);
    return await actOnOrder(checkout, session, order);
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    console.warn(`PayPal confirm failed: ${error.message}`);
    if (isOrderGone(error)) return orderGone(checkout);
    return { checkout, unknown: true };
  }
}

function newOrder(checkout: CheckoutRecord) {
  const origin = publicOrigin();
  if (!origin) throw new PaypalError("unavailable", "public_url_invalid");
  const { snapshot, id } = checkout;
  return {
    requestId: orderRequestId(id),
    customId: id,
    name: snapshot.product.name,
    description: snapshot.variant?.name ?? null,
    quantity: snapshot.quantity,
    unitAmount: snapshot.unitAmount,
    amount: snapshot.amount,
    currency: snapshot.currency,
    returnUrl: `${origin}/checkout/${id}/return`,
    cancelUrl: `${origin}/checkout/${id}?cancelled=1`,
  };
}

export type StartResult = { approvalUrl: string } | ConfirmResult;

async function continueOrder(checkout: CheckoutRecord, session: PaypalSession, orderId: string): Promise<StartResult> {
  try {
    const order = await getOrder(session, orderId);
    if (order.stage === "waiting_for_buyer" && order.approvalUrl) return { approvalUrl: order.approvalUrl };
    return await actOnOrder(checkout, session, order);
  } catch (error) {
    if (error instanceof PaypalError && isOrderGone(error)) return orderGone(checkout);
    throw error;
  }
}

/** Makes the checkout's one PayPal order, or reuses it. Throws a PaypalError if PayPal says no or can't be reached. */
export async function startPayment(checkout: CheckoutRecord): Promise<StartResult> {
  if (checkout.moneyStatus !== "pending" || isSettled(checkout)) return known(checkout);

  const session = await sessionFor(checkout);
  if (checkout.paypalOrderId) return continueOrder(checkout, session, checkout.paypalOrderId);

  const order = await createOrder(session, newOrder(checkout));
  const saved = await saveCheckoutOrder(checkout.id, order.id, order.sellerId);
  // Never hand out an approval link for an order that isn't this checkout's one order.
  if (saved.paypalOrderId !== order.id) return continueOrder(saved, session, saved.paypalOrderId!);

  const mismatch = findOrderMismatch(expectedFor(saved), order);
  if (mismatch) return known(await recordCheckoutMoney(saved.id, { moneyStatus: "unresolved", moneyReason: mismatch }));
  if (!order.approvalUrl) throw new PaypalError("unavailable", "no_approval_link");
  return { approvalUrl: order.approvalUrl };
}

export const checkoutUrlFor = (id: string) => `${publicOrigin() ?? ""}/checkout/${id}`;

/** What the merchant's backend sees. `fulfillment` and `sync` stay fixed until M06 and M07 can change them. */
export function toCheckoutResponse(checkout: CheckoutRecord): CheckoutResponse {
  const money = showMoneyStatus(checkout);
  return checkoutResponseSchema.parse({
    id: checkout.id,
    externalCustomerId: checkout.externalCustomerId,
    checkoutUrl: checkoutUrlFor(checkout.id),
    expiresAt: checkout.expiresAt.toISOString(),
    money,
    fulfillment: "pending",
    sync: "not_configured",
    nextAction: nextActionFor(money),
    snapshot: checkout.snapshot,
    paypal: { orderId: checkout.paypalOrderId, captureId: checkout.paypalCaptureId },
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
