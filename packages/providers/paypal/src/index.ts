import { z } from "zod";

// Each connection's environment picks its address. Not an env var: one deploy can hold both
// environments, and a wrong value would send real credentials to the wrong host.
const API_URLS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};
export type PaypalEnvironment = keyof typeof API_URLS;

const REQUEST_TIMEOUT_MS = 10_000;

export const WEBHOOK_EVENTS = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.COMPLETED",
];

const CAPABILITY_SCOPES = {
  checkout: "https://uri.paypal.com/services/payments/payment/authcapture",
  subscriptions: "https://uri.paypal.com/services/subscriptions",
  webhooks: "https://uri.paypal.com/services/applications/webhooks",
};
export type PaypalCapabilities = Record<keyof typeof CAPABILITY_SCOPES, boolean>;

/** "rejected": PayPal answered no. "unavailable": no usable answer, so the outcome isn't known. */
export class PaypalError extends Error {
  constructor(
    readonly kind: "rejected" | "unavailable",
    readonly code?: string,
    readonly debugId?: string,
  ) {
    // Only safe fields: never a response body, header or token.
    super(`PayPal ${kind}${code ? ` (${code})` : ""}${debugId ? ` debug_id=${debugId}` : ""}`);
    this.name = "PaypalError";
  }
}

export type PaypalCredentials = { environment: PaypalEnvironment; clientId: string; clientSecret: string };
export type PaypalSession = { environment: PaypalEnvironment; accessToken: string; scopes: string[] };
export type PaypalWebhook = { id: string; url: string; events: string[] };

const errorBodySchema = z.looseObject({ name: z.string().optional(), error: z.string().optional() });
const tokenSchema = z.looseObject({ access_token: z.string(), scope: z.string() });
const webhookSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  event_types: z.array(z.looseObject({ name: z.string() })),
});
const webhookListSchema = z.looseObject({ webhooks: z.array(webhookSchema) });

async function send(environment: PaypalEnvironment, path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API_URLS[environment]}${path}`, {
      ...init,
      // Next's fetch cache writes to disk, and these responses can carry tokens.
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new PaypalError("unavailable");
  }
  if (response.ok) return response;

  const debugId = response.headers.get("paypal-debug-id") ?? undefined;
  const body = errorBodySchema.safeParse(await response.json().catch(() => null));
  const code = body.success ? (body.data.name ?? body.data.error) : undefined;
  const unavailable = response.status === 429 || response.status >= 500;
  throw new PaypalError(unavailable ? "unavailable" : "rejected", code, debugId);
}

async function parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body = schema.safeParse(await response.json().catch(() => null));
  if (!body.success) throw new PaypalError("unavailable", "unexpected_response");
  return body.data;
}

function authorized(session: PaypalSession, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
  };
}

export async function openSession({ environment, clientId, clientSecret }: PaypalCredentials): Promise<PaypalSession> {
  const response = await send(environment, "/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const token = await parse(response, tokenSchema);
  return { environment, accessToken: token.access_token, scopes: token.scope.split(" ") };
}

export function readCapabilities(scopes: string[]): PaypalCapabilities {
  return {
    checkout: scopes.includes(CAPABILITY_SCOPES.checkout),
    subscriptions: scopes.includes(CAPABILITY_SCOPES.subscriptions),
    webhooks: scopes.includes(CAPABILITY_SCOPES.webhooks),
  };
}

export async function findWebhook(session: PaypalSession, url: string): Promise<PaypalWebhook | undefined> {
  const response = await send(session.environment, "/v1/notifications/webhooks", authorized(session));
  const { webhooks } = await parse(response, webhookListSchema);
  const match = webhooks.find((webhook) => webhook.url === url);
  return match && { id: match.id, url: match.url, events: match.event_types.map((event) => event.name) };
}

export function hasOurEvents(webhook: PaypalWebhook): boolean {
  return (
    webhook.events.length === WEBHOOK_EVENTS.length && WEBHOOK_EVENTS.every((event) => webhook.events.includes(event))
  );
}

const eventTypes = () => WEBHOOK_EVENTS.map((name) => ({ name }));

/**
 * Safe to repeat. It looks before creating, so a retry after a timeout finds a webhook that was
 * actually created. Only the webhook with this exact URL is ever changed.
 */
export async function ensureWebhook(session: PaypalSession, url: string): Promise<string> {
  const existing = await findWebhook(session, url);
  if (existing) {
    if (!hasOurEvents(existing)) {
      await send(
        session.environment,
        `/v1/notifications/webhooks/${encodeURIComponent(existing.id)}`,
        authorized(session, {
          method: "PATCH",
          body: JSON.stringify([{ op: "replace", path: "/event_types", value: eventTypes() }]),
        }),
      );
    }
    return existing.id;
  }

  try {
    const response = await send(
      session.environment,
      "/v1/notifications/webhooks",
      authorized(session, { method: "POST", body: JSON.stringify({ url, event_types: eventTypes() }) }),
    );
    return (await parse(response, webhookSchema)).id;
  } catch (error) {
    // Lost a race with another save: the webhook now exists, so reuse it.
    if (error instanceof PaypalError && error.code === "WEBHOOK_URL_ALREADY_EXISTS") {
      const created = await findWebhook(session, url);
      if (created) return created.id;
    }
    throw error;
  }
}
