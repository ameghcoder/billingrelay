import { jsonResponse } from "@/lib/api-response";
import { startPayment, toPublicCheckout } from "@/lib/checkout";
import { withCheckout } from "@/lib/checkout-routes";

export const POST = withCheckout(async (checkout) => {
  const result = await startPayment(checkout);
  if ("approvalUrl" in result) return jsonResponse({ approvalUrl: result.approvalUrl });
  return jsonResponse(toPublicCheckout(result.checkout), result.unknown ? 503 : 200);
});
