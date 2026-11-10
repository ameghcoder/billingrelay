import { cancelSubscriptionAtPaypal } from "@billingrelay/billing";
import { findSubscription, getSubscription } from "@billingrelay/db";
import { apiError, isUuid, jsonResponse } from "@/lib/api-response";
import { toSubscriptionSummary } from "@/lib/subscription";
import { withApiKey } from "@/lib/v1-routes";

type Context = { params: Promise<{ id: string }> };

/** Stops renewals at PayPal. Access stays until `accessUntil`, which this doesn't change. Safe to repeat. */
export const POST = withApiKey<Context>(async ({ apiKey, context }) => {
  const { id } = await context.params;
  const subscription = isUuid(id) ? await getSubscription(apiKey, id) : null;
  if (!subscription) return apiError(404, "not_found", "No such subscription");
  if (subscription.status === "pending") return apiError(409, "subscription_not_started", "The buyer hasn't approved this subscription, so there's nothing to cancel");

  const { unknown } = await cancelSubscriptionAtPaypal(subscription);
  if (unknown) return apiError(503, "paypal_unavailable", "PayPal couldn't be reached, so renewals may not be stopped yet. Try again shortly.");
  return jsonResponse(toSubscriptionSummary((await findSubscription(subscription.id))!));
});
