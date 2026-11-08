import { confirmPayment } from "@billingrelay/billing";
import { jsonResponse } from "@/lib/api-response";
import { toPublicCheckout } from "@/lib/checkout";
import { withCheckout } from "@/lib/checkout-routes";
import { RATE_RULES } from "@/lib/rate-limit";

export const POST = withCheckout(RATE_RULES.checkoutConfirm, async (checkout) => {
  const { checkout: current, unknown } = await confirmPayment(checkout);
  return jsonResponse(toPublicCheckout(current), unknown ? 503 : 200);
});
