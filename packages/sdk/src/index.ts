// The server SDK: typed calls to BillingRelay's /v1 API, with the same request and response shapes the routes use. Keep the API key on
// your server. Business rules live in BillingRelay; this only sends requests and checks what comes back.
import { catalogCheckoutRequestSchema, checkoutResponseSchema, quoteCheckoutRequestSchema, type CheckoutResponse } from "@billingrelay/core/checkouts";
import { billingResponseSchema, compensateResponseSchema, consumeRequestSchema, consumeResponseSchema, type BillingResponse, type CompensateResponse, type ConsumeResponse } from "@billingrelay/core/credits";
import { catalogQuoteRequestSchema, checkQuoteRequestSchema, merchantQuoteRequestSchema, quoteResponseSchema, type QuoteResponse } from "@billingrelay/core/quotes";
import { subscriptionSummarySchema, type SubscriptionSummary } from "@billingrelay/core/subscriptions";
import type { z } from "zod";

export type { BillingResponse, CheckoutResponse, CompensateResponse, ConsumeResponse, QuoteResponse, SubscriptionSummary };

/** A refusal from BillingRelay, with its code (such as `insufficient_credits` or `subscription_exists`) and any details. */
export class BillingRelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BillingRelayError";
  }
}

export type BillingRelayOptions = {
  /** Where BillingRelay runs, such as https://billing.example.com. */
  baseUrl: string;
  /** A backend API key (`br_sandbox_…`), from Developers. Never send it to a browser. */
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** The same key on a retry returns the first answer instead of making a second purchase. Use your own order or job ID. */
export type Idempotent = { idempotencyKey: string };

export type CatalogQuote = z.input<typeof catalogQuoteRequestSchema>;
export type MerchantQuote = z.input<typeof merchantQuoteRequestSchema>;
export type CatalogCheckout = z.input<typeof catalogCheckoutRequestSchema>;
export type QuoteCheckout = z.input<typeof quoteCheckoutRequestSchema>;
export type QuoteCheck = z.input<typeof checkQuoteRequestSchema>;
export type Consume = z.input<typeof consumeRequestSchema>;

export function createBillingRelay(options: BillingRelayOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  async function call<Schema extends z.ZodType>(schema: Schema, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<z.infer<Schema>> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const error = json?.error ?? {};
      throw new BillingRelayError(response.status, error.code ?? "http_error", error.message ?? `BillingRelay answered ${response.status}`, error.details);
    }
    return schema.parse(json);
  }

  const path = (id: string) => encodeURIComponent(id);

  return {
    quotes: {
      /** A fixed price for one customer that expires. Prices from your live catalog, or your own for one-time items. */
      create: (quote: CatalogQuote | MerchantQuote, { idempotencyKey }: Idempotent): Promise<QuoteResponse> => call(quoteResponseSchema, "POST", "/v1/quotes", quote, idempotencyKey),
      /** Still valid for this customer? Refuses with `quote_expired` or `quote_customer_mismatch`. */
      check: (id: string, request: QuoteCheck): Promise<QuoteResponse> => call(quoteResponseSchema, "POST", `/v1/quotes/${path(id)}/check`, request),
    },
    checkouts: {
      /** Send the buyer to `checkoutUrl`. Their return to `returnUrl` proves nothing: read `get` from your server. */
      create: (checkout: CatalogCheckout | QuoteCheckout, { idempotencyKey }: Idempotent): Promise<CheckoutResponse> =>
        call(checkoutResponseSchema, "POST", "/v1/checkouts", checkout, idempotencyKey),
      /** Money, fulfillment and sync, kept separate, plus the next action. No PayPal call. */
      get: (id: string): Promise<CheckoutResponse> => call(checkoutResponseSchema, "GET", `/v1/checkouts/${path(id)}`),
    },
    subscriptions: {
      /** Stops renewals at PayPal. Access lasts until `accessUntil`. Safe to repeat. */
      cancel: (id: string): Promise<SubscriptionSummary> => call(subscriptionSummarySchema, "POST", `/v1/subscriptions/${path(id)}/cancel`),
    },
    credits: {
      /** Debit before doing the work. The same `usageId` again returns the same answer; never past zero. */
      consume: (request: Consume): Promise<ConsumeResponse> =>
        call(consumeResponseSchema, "POST", "/v1/credits/consume", request),
      /** The work failed: give that debit back, once. */
      compensate: (usageId: string): Promise<CompensateResponse> => call(compensateResponseSchema, "POST", `/v1/usage/${path(usageId)}/compensate`),
    },
    customers: {
      /** Access, subscriptions, paid purchases and credits for one of your users, as BillingRelay has them now. */
      billing: (externalCustomerId: string): Promise<BillingResponse> => call(billingResponseSchema, "GET", `/v1/customers/${path(externalCustomerId)}/billing`),
    },
  };
}

export type BillingRelay = ReturnType<typeof createBillingRelay>;
