import { confirmPayment } from "@billingrelay/billing";
import { jsonResponse } from "@/lib/api-response";
import { toPublicCheckout } from "@/lib/checkout";
import { withCheckout } from "@/lib/checkout-routes";

export const POST = withCheckout(async (checkout) => {
  const { checkout: current, unknown } = await confirmPayment(checkout);
  return jsonResponse(toPublicCheckout(current), unknown ? 503 : 200);
});
