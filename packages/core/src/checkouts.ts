import { z } from "zod";
import { subscriptionSummarySchema } from "./subscriptions";
import { catalogQuoteRequestSchema, externalCustomerIdSchema, quoteSnapshotSchema } from "./quotes";
import { CHECKOUT_SYNC_STATUSES } from "./sync";

/** A checkout has its own hour, however close its quote was to expiring. Nothing is charged after it. */
export const CHECKOUT_LIFETIME_SECONDS = 3600;

export const MONEY_STATUSES = ["pending", "approved", "captured", "failed", "unresolved", "refund_review"] as const;
export type StoredMoneyStatus = (typeof MONEY_STATUSES)[number];
/** `expired` is never stored. It's worked out on read, like a quote's status. */
export type MoneyStatus = StoredMoneyStatus | "expired";
export type NextAction = "redirect" | "wait" | "none" | "contact_support";

export const MONEY_REASONS = [
  "capture_outcome_unknown",
  "reference_mismatch",
  "intent_mismatch",
  "amount_mismatch",
  "currency_mismatch",
  "seller_mismatch",
  "unexpected_capture",
  "paypal_declined",
  "order_gone",
] as const;
export type MoneyReason = (typeof MONEY_REASONS)[number];

export const FULFILLMENT_STATUSES = ["pending", "applied", "restricted", "failed"] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];
export const FULFILLMENT_REASONS = ["waiting_for_credit_ledger"] as const;
export type FulfillmentReason = (typeof FULFILLMENT_REASONS)[number];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin of an address a buyer may be sent to, or null. HTTPS only, except on this machine. */
function safeOrigin(address: string): string | null {
  if (!URL.canParse(address)) return null;
  const url = new URL(address);
  if (url.username || url.password) return null;
  const allowed = url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  return allowed ? url.origin : null;
}

export const returnOriginOf = (returnUrl: string) => safeOrigin(returnUrl);

const returnUrlSchema = z
  .string({ error: "Send the address to bring the buyer back to" })
  .max(2048, "Up to 2048 characters")
  .refine((address) => safeOrigin(address) !== null, "Use a full https address, with no username or password");

export const addReturnOriginSchema = z.strictObject({
  origin: z
    .string({ error: "Enter an origin" })
    .trim()
    .max(255, "Up to 255 characters")
    .refine((origin) => safeOrigin(origin) === origin.replace(/\/$/, ""), "Use only the scheme and host, such as https://app.example.com")
    .transform((origin) => origin.replace(/\/$/, "")),
});
export type AddReturnOrigin = z.input<typeof addReturnOriginSchema>;

export const returnOriginSummarySchema = z.object({ id: z.string(), origin: z.string(), createdAt: z.string() });
export type ReturnOriginSummary = z.infer<typeof returnOriginSummarySchema>;

export const quoteCheckoutRequestSchema = z.strictObject({
  externalCustomerId: externalCustomerIdSchema,
  quoteId: z.uuid({ error: "Send the quote's id" }),
  returnUrl: returnUrlSchema,
});

export const catalogCheckoutRequestSchema = catalogQuoteRequestSchema.omit({ expiresInSeconds: true }).extend({ returnUrl: returnUrlSchema });

/** `quoteId` picks the form, so that form's strict rules can name any field that doesn't belong. */
export function parseCheckoutRequest(body: unknown) {
  const fromQuote = typeof body === "object" && body !== null && "quoteId" in body;
  return fromQuote ? quoteCheckoutRequestSchema.safeParse(body) : catalogCheckoutRequestSchema.safeParse(body);
}

const moneySchema = z.enum([...MONEY_STATUSES, "expired"]);
const nextActionSchema = z.enum(["redirect", "wait", "none", "contact_support"]);

export const checkoutResponseSchema = z.object({
  id: z.string(),
  externalCustomerId: z.string(),
  checkoutUrl: z.string(),
  expiresAt: z.string(),
  money: moneySchema,
  fulfillment: z.enum(FULFILLMENT_STATUSES),
  sync: z.enum(CHECKOUT_SYNC_STATUSES),
  nextAction: nextActionSchema,
  snapshot: quoteSnapshotSchema,
  paypal: z.object({ orderId: z.string().nullable(), captureId: z.string().nullable() }),
  // A subscription checkout's subscription, once the buyer has clicked Pay. Null for everything else.
  subscription: subscriptionSummarySchema.nullable(),
});
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;

/** What a buyer's browser may see. Holding the link is its only credential, so no customer ID, metadata or PayPal ID. */
export const publicCheckoutSchema = z.object({ money: moneySchema, nextAction: nextActionSchema, settled: z.boolean(), backUrl: z.string() });
export type PublicCheckout = z.infer<typeof publicCheckoutSchema>;

type MoneyState = {
  moneyStatus: StoredMoneyStatus;
  moneyReason: MoneyReason | null;
  captureRequestedAt: Date | null;
  isExpired: boolean;
};

/** Once a capture has been sent, money may have moved, so the checkout can never read as expired. */
export const hasExpired = ({ moneyStatus, captureRequestedAt, isExpired }: MoneyState) =>
  isExpired && captureRequestedAt === null && (moneyStatus === "pending" || moneyStatus === "approved");

export const showMoneyStatus = (state: MoneyState): MoneyStatus => (hasExpired(state) ? "expired" : state.moneyStatus);

/** True when PayPal can't tell us anything that would change this checkout. */
export function isSettled(state: MoneyState): boolean {
  if (hasExpired(state)) return true;
  if (state.moneyStatus === "unresolved") return state.moneyReason !== "capture_outcome_unknown";
  return state.moneyStatus === "captured" || state.moneyStatus === "failed" || state.moneyStatus === "refund_review";
}

const NEXT_ACTIONS: Record<MoneyStatus, NextAction> = {
  pending: "redirect",
  approved: "wait",
  captured: "none",
  failed: "none",
  expired: "none",
  unresolved: "contact_support",
  refund_review: "contact_support",
};

export const nextActionFor = (money: MoneyStatus) => NEXT_ACTIONS[money];

type Expected = { checkoutId: string; amount: number; currency: string; sellerId: string | null };

type OrderFacts = {
  isCaptureIntent: boolean;
  purchaseUnitCount: number;
  amount: number | null;
  currency: string | null;
  customId: string | null;
  sellerId: string | null;
};

type CaptureFacts = {
  id: string;
  state: "completed" | "refunded" | "pending" | "declined" | "other";
  amount: number | null;
  currency: string;
  customId: string | null;
  sellerId: string | null;
};

/** Is this the order we asked for? Checked before any capture, while no money has moved. */
export function findOrderMismatch(expected: Expected, order: OrderFacts): MoneyReason | null {
  if (order.purchaseUnitCount !== 1 || order.customId !== expected.checkoutId) return "reference_mismatch";
  if (!order.isCaptureIntent) return "intent_mismatch";
  if (order.currency !== expected.currency) return "currency_mismatch";
  if (order.amount !== expected.amount) return "amount_mismatch";
  if (order.sellerId === null || order.sellerId !== expected.sellerId) return "seller_mismatch";
  return null;
}

export type CaptureOutcome = {
  moneyStatus: "captured" | "approved" | "failed" | "unresolved";
  moneyReason: MoneyReason | null;
  capture: CaptureFacts | null;
};

/** What PayPal's capture means for this checkout. Only a completed capture that matches in full is `captured`. */
export function judgeCaptures(expected: Expected, captures: CaptureFacts[]): CaptureOutcome {
  const [capture] = captures;
  // Nothing to judge, and money may have moved, so the next confirm has to be able to ask again.
  if (!capture) return { moneyStatus: "unresolved", moneyReason: "capture_outcome_unknown", capture: null };
  if (captures.length > 1) return { moneyStatus: "unresolved", moneyReason: "unexpected_capture", capture };

  if (capture.state === "pending") return { moneyStatus: "approved", moneyReason: null, capture };
  if (capture.state === "declined") return { moneyStatus: "failed", moneyReason: "paypal_declined", capture };
  // A refunded capture did complete. It's judged the same way, and the refund's own event then moves it to review.
  if (capture.state !== "completed" && capture.state !== "refunded") return { moneyStatus: "unresolved", moneyReason: "unexpected_capture", capture };

  let moneyReason: MoneyReason | null = null;
  // A capture that doesn't repeat the reference isn't a mismatch: it came from the order we checked.
  if (capture.customId !== null && capture.customId !== expected.checkoutId) moneyReason = "reference_mismatch";
  else if (capture.currency !== expected.currency) moneyReason = "currency_mismatch";
  else if (capture.amount !== expected.amount) moneyReason = "amount_mismatch";
  else if (capture.sellerId === null || capture.sellerId !== expected.sellerId) moneyReason = "seller_mismatch";

  return moneyReason ? { moneyStatus: "unresolved", moneyReason, capture } : { moneyStatus: "captured", moneyReason: null, capture };
}
