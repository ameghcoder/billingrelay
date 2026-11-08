import { findCheckout, type CheckoutRecord } from "@billingrelay/db";
import { PaypalError } from "@billingrelay/provider-paypal";
import type { RateRule } from "@billingrelay/core/rate-limit";
import { apiError, isUuid } from "./api-response";
import { clientIp, limiter, tooManyRequests } from "./rate-limit";

type CheckoutContext = { params: Promise<{ id: string }> };

/** Hosted checkout routes: no login, because holding the link is the only credential. Failures log only safe fields. */
export function withCheckout(rule: RateRule, handler: (checkout: CheckoutRecord) => Promise<Response>) {
  return async (request: Request, context: CheckoutContext): Promise<Response> => {
    try {
      const { id } = await context.params;
      const decision = limiter.hit(rule, `${clientIp(request.headers)} ${id}`);
      if (!decision.allowed) return tooManyRequests(decision);
      const checkout = isUuid(id) ? await findCheckout(id) : null;
      if (!checkout) return apiError(404, "not_found", "No such checkout");
      if (checkout.environment !== "sandbox") return apiError(422, "live_disabled", "Live is not enabled");
      return await handler(checkout);
    } catch (error) {
      if (error instanceof PaypalError) {
        console.warn(`PayPal checkout call failed: ${error.message}`);
        return error.kind === "rejected"
          ? apiError(502, "paypal_rejected", "PayPal refused this request. Nothing was charged.")
          : apiError(503, "paypal_unavailable", "PayPal can't be reached right now. Nothing was charged. Try again shortly.");
      }
      console.error(`Checkout route failed: ${error instanceof Error ? error.name : "unknown"}`);
      return apiError(500, "internal_error", "Something went wrong. Try again shortly.");
    }
  };
}
