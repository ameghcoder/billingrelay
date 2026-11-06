import { getCheckout } from "@billingrelay/db";
import { apiError, isUuid, jsonResponse } from "@/lib/api-response";
import { toCheckoutResponse } from "@/lib/checkout";
import { withApiKey } from "@/lib/v1-routes";

type Context = { params: Promise<{ id: string }> };

/** Read-only, with no PayPal call: what BillingRelay knows right now. */
export const GET = withApiKey<Context>(async ({ apiKey, context }) => {
  const { id } = await context.params;
  const checkout = isUuid(id) ? await getCheckout(apiKey, id) : null;
  if (!checkout) return apiError(404, "not_found", "No such checkout");
  return jsonResponse(toCheckoutResponse(checkout));
});
