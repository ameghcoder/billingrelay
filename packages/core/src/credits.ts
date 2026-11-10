import { z } from "zod";
import { externalCustomerIdSchema } from "./quotes";
import { subscriptionSummarySchema } from "./subscriptions";

/** One debit can't take more than this; balances themselves are bigint. */
export const MAX_CREDIT_DEBIT = 1_000_000_000;

export const CREDIT_BUCKETS = ["monthly", "pack"] as const;
export type CreditBucket = (typeof CREDIT_BUCKETS)[number];

// Printable, no spaces: the merchant's own ID for one piece of work, the same rules as an Idempotency-Key.
export const usageIdSchema = z.string({ error: "Send usageId" }).regex(/^[\x21-\x7e]{1,255}$/, "1 to 255 printable characters, no spaces");

export const consumeRequestSchema = z.strictObject({
  externalCustomerId: externalCustomerIdSchema,
  amount: z.int({ error: "Must be a whole number of credits" }).positive("Must be more than 0").max(MAX_CREDIT_DEBIT, `Must be ${MAX_CREDIT_DEBIT} or less`),
  usageId: usageIdSchema,
});
export type ConsumeRequest = z.infer<typeof consumeRequestSchema>;

export const creditBalanceSchema = z.object({
  monthly: z.number(),
  packs: z.number(),
  total: z.number(),
  // When the monthly credits stop counting. Null with none left.
  monthlyEndsAt: z.string().nullable(),
});
export type CreditBalance = z.infer<typeof creditBalanceSchema>;

export const consumeResponseSchema = z.object({ usageId: z.string(), debited: z.number(), balance: creditBalanceSchema });
export type ConsumeResponse = z.infer<typeof consumeResponseSchema>;

export const compensateResponseSchema = z.object({ usageId: z.string(), compensated: z.number(), balance: creditBalanceSchema });
export type CompensateResponse = z.infer<typeof compensateResponseSchema>;

export type SpendableLot = { id: string; bucket: CreditBucket; remaining: number; expiresAt: Date | null; createdAt: Date };
export type Allocation = { lotId: string; amount: number }[];

/**
 * What a debit takes from each lot: monthly credits first, soonest ending first, then packs, oldest first. Null when there
 * isn't enough. The caller passes only lots that can be spent now (active, not past their end).
 */
export function allocateDebit(lots: SpendableLot[], amount: number): Allocation | null {
  const order = [...lots].sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket === "monthly" ? -1 : 1;
    const ends = (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity);
    if (ends !== 0 && !Number.isNaN(ends)) return ends;
    return a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1);
  });
  const allocation: Allocation = [];
  let left = amount;
  for (const lot of order) {
    if (left === 0) break;
    const take = Math.min(lot.remaining, left);
    if (take > 0) allocation.push({ lotId: lot.id, amount: take });
    left -= take;
  }
  return left === 0 ? allocation : null;
}

export const billingResponseSchema = z.object({
  externalCustomerId: z.string(),
  // Grows with every change to this customer's billing, so a cached copy can tell it's stale.
  version: z.number(),
  access: z.array(
    z.object({
      key: z.string(),
      // Active now: not restricted and, for a subscription, not past `activeUntil`.
      active: z.boolean(),
      status: z.enum(["active", "restricted"]),
      activeUntil: z.string().nullable(),
      checkoutId: z.string(),
    }),
  ),
  subscriptions: z.array(subscriptionSummarySchema.extend({ productRef: z.string(), checkoutId: z.string() })),
  purchases: z.array(
    z.object({
      checkoutId: z.string(),
      productRef: z.string(),
      productKind: z.string(),
      amount: z.number(),
      currency: z.string(),
      money: z.string(),
      fulfillment: z.string(),
      createdAt: z.string(),
    }),
  ),
  credits: creditBalanceSchema,
});
export type BillingResponse = z.infer<typeof billingResponseSchema>;
