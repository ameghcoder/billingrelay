import { billingResponseSchema } from "@billingrelay/core/credits";
import { externalCustomerIdSchema } from "@billingrelay/core/quotes";
import { getCustomerBilling } from "@billingrelay/db";
import { apiError, jsonResponse } from "@/lib/api-response";
import { withApiKey } from "@/lib/v1-routes";

type Context = { params: Promise<{ externalCustomerId: string }> };

/** Everything one customer has, read-only, with no PayPal call. Decide access and spending from this or the synced tables. */
export const GET = withApiKey<Context>(async ({ apiKey, context }) => {
  const id = externalCustomerIdSchema.safeParse((await context.params).externalCustomerId);
  const billing = id.success ? await getCustomerBilling(apiKey, id.data) : null;
  if (!billing) return apiError(404, "not_found", "No such customer");
  return jsonResponse(billingResponseSchema.parse(billing));
});
