import { z } from "zod";

/** Renewals post hours after PayPal's billing time (2 to 6 hours in sandbox), so access and monthly credits run this long past it. */
export const ACCESS_GRACE_MS = 24 * 60 * 60 * 1000;

export const SUBSCRIPTION_STATUSES = ["pending", "active", "suspended", "cancelled", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Why a subscription's payments stopped counting. A person looks at it: money moved that doesn't match what was sold. */
export const SUBSCRIPTION_REVIEW_REASONS = ["reference_mismatch", "plan_mismatch", "amount_mismatch", "currency_mismatch"] as const;
export type SubscriptionReviewReason = (typeof SUBSCRIPTION_REVIEW_REASONS)[number];

export const accessUntil = (paidThrough: Date) => new Date(paidThrough.getTime() + ACCESS_GRACE_MS);

const STATUS_FOR_STAGE: Record<string, SubscriptionStatus> = {
  waiting_for_buyer: "pending",
  active: "active",
  suspended: "suspended",
  cancelled: "cancelled",
  expired: "expired",
};

/** PayPal's stage as we store it. "other" (such as approved, first payment still running) keeps whatever was stored. */
export const statusForStage = (stage: string, stored: SubscriptionStatus): SubscriptionStatus => STATUS_FOR_STAGE[stage] ?? stored;

type Expected = { checkoutId: string; planId: string; amount: number; currency: string };
type Read = { customId: string | null; planId: string | null };
type Payment = { state: "completed" | "refunded" | "other"; amount: number | null; currency: string };

/** Is this PayPal subscription the one we created for this checkout? Checked before any of its payments count. */
export function findSubscriptionMismatch(expected: Expected, read: Read): SubscriptionReviewReason | null {
  if (read.customId !== expected.checkoutId) return "reference_mismatch";
  if (read.planId !== expected.planId) return "plan_mismatch";
  return null;
}

/** A payment pays for a period only when it completed for exactly the plan's price. A refunded one did complete, and stays counted. */
export function judgeSubscriptionPayment(expected: Expected, payment: Payment): "counts" | "not_completed" | SubscriptionReviewReason {
  if (payment.state === "other") return "not_completed";
  if (payment.currency !== expected.currency) return "currency_mismatch";
  if (payment.amount !== expected.amount) return "amount_mismatch";
  return "counts";
}

const LOOK_AFTER_BILLING_MS = [1, 6, 25].map((hours) => hours * 60 * 60 * 1000);

/** When the worker asks PayPal again with no event: a while after each renewal is due, in case its event never comes. */
export function nextSubscriptionCheck(nextBillingTime: Date | null, now: Date): Date | null {
  if (!nextBillingTime) return null;
  const due = LOOK_AFTER_BILLING_MS.map((offset) => nextBillingTime.getTime() + offset).find((time) => time > now.getTime());
  return due === undefined ? null : new Date(due);
}

export const subscriptionSummarySchema = z.object({
  id: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  reviewReason: z.enum(SUBSCRIPTION_REVIEW_REASONS).nullable(),
  // PayPal's next billing time after the last counted payment. Access lasts 24 hours longer.
  paidThrough: z.string().nullable(),
  accessUntil: z.string().nullable(),
  cancelRequested: z.boolean(),
});
export type SubscriptionSummary = z.infer<typeof subscriptionSummarySchema>;
