import { z } from "zod";

/** What a merchant sees for one checkout. `pending` means not in their database yet, including a checkout nothing has happened to. */
export const CHECKOUT_SYNC_STATUSES = ["not_configured", "pending", "delivered", "failed"] as const;
export type CheckoutSyncStatus = (typeof CHECKOUT_SYNC_STATUSES)[number];

export const OUTBOX_STATUSES = ["pending", "delivered", "failed"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** `checking` until the worker has looked. `down` and `not_ready` wait without using up any row's attempts. */
export const DESTINATION_STATES = ["not_configured", "checking", "ok", "down", "not_ready"] as const;
export type DestinationState = (typeof DESTINATION_STATES)[number];

/** `unchanged`: the destination already had this version or a newer one. */
export const SYNC_OUTCOMES = ["delivered", "unchanged", "refused", "down", "not_ready"] as const;
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number];

// What goes to the merchant's database. Fixed columns, and nothing that names the buyer.
export type CustomerProjection = { projectId: string; customerId: string; externalCustomerId: string };

export type PurchaseProjection = CustomerProjection & {
  checkoutId: string;
  environment: string;
  productRef: string;
  productName: string;
  productKind: string;
  variantRef: string | null;
  quantity: number;
  amount: number;
  currency: string;
  moneyStatus: string;
  fulfillmentStatus: string;
  paypalCaptureId: string | null;
  metadata: Record<string, string>;
  expiresAt: Date;
  createdAt: Date;
  sourceVersion: number;
  sourceUpdatedAt: Date;
};

export type AccessProjection = CustomerProjection & {
  grantId: string;
  environment: string;
  accessKey: string;
  checkoutId: string;
  status: string;
  // Empty for a one-time purchase. A subscription's access ends then unless a renewal moves it.
  activeUntil: Date | null;
  sourceVersion: number;
  sourceUpdatedAt: Date;
};

export type SubscriptionProjection = CustomerProjection & {
  subscriptionId: string;
  environment: string;
  checkoutId: string;
  productRef: string;
  status: string;
  reviewReason: string | null;
  paidThrough: Date | null;
  accessUntil: Date | null;
  cancelRequested: boolean;
  paypalSubscriptionId: string;
  sourceVersion: number;
  sourceUpdatedAt: Date;
};

export type CreditBalanceProjection = CustomerProjection & {
  accountId: string;
  environment: string;
  monthly: number;
  packs: number;
  total: number;
  monthlyEndsAt: Date | null;
  sourceVersion: number;
  sourceUpdatedAt: Date;
};

export const SYNC_ENTITY_TYPES = ["checkout", "access_grant", "subscription", "credit_account"] as const;
export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export type Projection =
  | { entityType: "checkout"; row: PurchaseProjection }
  | { entityType: "access_grant"; row: AccessProjection }
  | { entityType: "subscription"; row: SubscriptionProjection }
  | { entityType: "credit_account"; row: CreditBalanceProjection };

export const syncStatusResponseSchema = z.object({
  destination: z.object({
    state: z.enum(DESTINATION_STATES),
    code: z.string().nullable(),
    downSince: z.string().nullable(),
    nextTryAt: z.string().nullable(),
  }),
  pending: z.number(),
  failed: z.number(),
  // Age of the oldest change still waiting, in seconds. Null when nothing waits.
  lagSeconds: z.number().nullable(),
  lastDeliveredAt: z.string().nullable(),
  attempts: z.array(
    z.object({
      at: z.string(),
      outcome: z.enum(SYNC_OUTCOMES),
      code: z.string().nullable(),
      entityType: z.string().nullable(),
      entityId: z.string().nullable(),
      durationMs: z.number().nullable(),
    }),
  ),
});
export type SyncStatusResponse = z.infer<typeof syncStatusResponseSchema>;
