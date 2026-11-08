import { clientIpFrom, createRateLimiter, type RateDecision, type RateRule } from "@billingrelay/core/rate-limit";

export const RATE_RULES = {
  /** Only refused keys count: each costs a database read. Valid keys are limited per key instead. */
  apiKeyRefusedPerIp: { name: "v1-refused-ip", max: 120, windowSeconds: 60 },
  apiKey: { name: "v1-key", max: 600, windowSeconds: 60 },
  /** Each one calls PayPal. The page confirms up to 8 times per load, so a reload or two stays allowed. */
  checkoutPay: { name: "checkout-pay", max: 10, windowSeconds: 60 },
  checkoutConfirm: { name: "checkout-confirm", max: 20, windowSeconds: 60 },
  checkoutPage: { name: "checkout-page", max: 60, windowSeconds: 60 },
  /** Only events PayPal refused count, so real events never use it up. A real event sent during a flood is resent by PayPal. */
  webhookRefused: { name: "webhook-refused", max: 30, windowSeconds: 60 },
} satisfies Record<string, RateRule>;

// Kept on globalThis: Next can load this module more than once, and each copy would otherwise count on its own.
const store = globalThis as typeof globalThis & { billingrelayLimiter?: ReturnType<typeof createRateLimiter> };
export const limiter = (store.billingrelayLimiter ??= createRateLimiter());

/** Read per request, so tests and deployments can set it without a rebuild. */
export const clientIp = (headers: Headers) => clientIpFrom(headers, process.env.CLIENT_IP_HEADER || undefined);

export const tooManyRequests = (decision: Extract<RateDecision, { allowed: false }>) =>
  Response.json(
    { error: { code: "rate_limited", message: "Too many requests. Try again shortly." } },
    { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(decision.retryAfterSeconds) } },
  );
