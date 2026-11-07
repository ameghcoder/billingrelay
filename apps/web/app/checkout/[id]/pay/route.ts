import { startPayment } from "@billingrelay/billing";
import { jsonResponse } from "@/lib/api-response";
import { toPublicCheckout } from "@/lib/checkout";
import { withCheckout } from "@/lib/checkout-routes";
import { publicOrigin } from "@/lib/paypal-connection";

export const POST = withCheckout(async (checkout) => {
  const result = await startPayment(checkout, publicOrigin());
  if ("approvalUrl" in result) return jsonResponse({ approvalUrl: result.approvalUrl });
  return jsonResponse(toPublicCheckout(result.checkout), result.unknown ? 503 : 200);
});
