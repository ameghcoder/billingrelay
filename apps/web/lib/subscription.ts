import { subscriptionSummarySchema, type SubscriptionSummary } from "@billingrelay/core/subscriptions";
import type { SubscriptionRecord } from "@billingrelay/db";

export const toSubscriptionSummary = (subscription: SubscriptionRecord): SubscriptionSummary =>
  subscriptionSummarySchema.parse({
    id: subscription.id,
    status: subscription.status,
    reviewReason: subscription.reviewReason,
    paidThrough: subscription.paidThrough?.toISOString() ?? null,
    accessUntil: subscription.accessUntil?.toISOString() ?? null,
    cancelRequested: subscription.cancelRequestedAt !== null,
  });
