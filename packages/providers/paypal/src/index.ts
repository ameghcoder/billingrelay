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

/**
 * "rejected": PayPal answered no. "unavailable": no usable answer, so the outcome isn't known.
 * `code` is PayPal's error name. `issue` is its more exact reason, such as ORDER_ALREADY_CAPTURED.
 */
export class PaypalError extends Error {
  constructor(
    readonly kind: "rejected" | "unavailable",
    readonly code?: string,
    readonly debugId?: string,
    readonly issue?: string,
  ) {
    // Only safe fields: never a response body, header or token.
    const reason = [code, issue].filter(Boolean).join(" ");
    super(`PayPal ${kind}${reason ? ` (${reason})` : ""}${debugId ? ` debug_id=${debugId}` : ""}`);
    this.name = "PaypalError";
  }
}

export type PaypalCredentials = { environment: PaypalEnvironment; clientId: string; clientSecret: string };
export type PaypalSession = { environment: PaypalEnvironment; accessToken: string; scopes: string[] };
export type PaypalWebhook = { id: string; url: string; events: string[] };

const errorBodySchema = z.looseObject({
  name: z.string().optional(),
  error: z.string().optional(),
  details: z.array(z.looseObject({ issue: z.string().optional() })).optional(),
});
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
  const issue = body.success ? body.data.details?.[0]?.issue : undefined;
  const unavailable = response.status === 429 || response.status >= 500;
  throw new PaypalError(unavailable ? "unavailable" : "rejected", code, debugId, issue);
}

async function parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body = schema.safeParse(await response.json().catch(() => null));
  if (!body.success) throw new PaypalError("unavailable", "unexpected_response");
  return body.data;
}

function authorized(session: PaypalSession, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json", ...init.headers },
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

/** Integer minor units to PayPal's text. Only two-decimal currencies get this far: the catalog refuses the rest. */
export function toPaypalValue(minorUnits: number): string {
  return `${Math.trunc(minorUnits / 100)}.${String(minorUnits % 100).padStart(2, "0")}`;
}

/** "1.0" and "1.00" both mean 100. Anything else is null, never a guess, and floats are never used. */
export function fromPaypalValue(value: string): number | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

const moneySchema = z.looseObject({ currency_code: z.string(), value: z.string() });
const payeeSchema = z.looseObject({ merchant_id: z.string().optional() });

const captureSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  amount: moneySchema,
  custom_id: z.string().optional(),
  payee: payeeSchema.optional(),
});

const orderSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  intent: z.string().optional(),
  links: z.array(z.looseObject({ rel: z.string(), href: z.string() })).optional(),
  purchase_units: z
    .array(
      z.looseObject({
        custom_id: z.string().optional(),
        amount: moneySchema,
        payee: payeeSchema.optional(),
        payments: z.looseObject({ captures: z.array(captureSchema).optional() }).optional(),
      }),
    )
    .optional(),
});

export type PaypalCapture = {
  id: string;
  state: "completed" | "pending" | "declined" | "other";
  amount: number | null;
  currency: string;
  customId: string | null;
  sellerId: string | null;
};

export type PaypalOrder = {
  id: string;
  stage: "waiting_for_buyer" | "approved" | "completed" | "voided" | "other";
  isCaptureIntent: boolean;
  purchaseUnitCount: number;
  amount: number | null;
  currency: string | null;
  customId: string | null;
  sellerId: string | null;
  approvalUrl: string | null;
  captures: PaypalCapture[];
};

// PayPal's words stop in this file. Everything else only sees what they mean for a payment.
const ORDER_STAGES = new Map<string, PaypalOrder["stage"]>([
  ["CREATED", "waiting_for_buyer"],
  ["SAVED", "waiting_for_buyer"],
  ["PAYER_ACTION_REQUIRED", "waiting_for_buyer"],
  ["APPROVED", "approved"],
  ["COMPLETED", "completed"],
  ["VOIDED", "voided"],
]);

const CAPTURE_STATES = new Map<string, PaypalCapture["state"]>([
  ["COMPLETED", "completed"],
  ["PENDING", "pending"],
  ["DECLINED", "declined"],
  ["FAILED", "declined"],
]);

/** Refusals that mean no money moved, so a new checkout is fine. Any other refusal doesn't prove that. */
const DECLINE_ISSUES = new Set([
  "INSTRUMENT_DECLINED",
  "TRANSACTION_REFUSED",
  "PAYER_CANNOT_PAY",
  "PAYER_ACCOUNT_RESTRICTED",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
  "REDIRECT_PAYER_FOR_ALTERNATE_FUNDING",
  "COMPLIANCE_VIOLATION",
]);

/** What a refused capture means. "other" doesn't prove whether money moved. */
export function captureRefusal(error: PaypalError): "declined" | "already_captured" | "other" {
  if (error.issue === "ORDER_ALREADY_CAPTURED") return "already_captured";
  return error.issue !== undefined && DECLINE_ISSUES.has(error.issue) ? "declined" : "other";
}

export const isOrderGone = (error: PaypalError) => error.code === "RESOURCE_NOT_FOUND";

/** Exported so tests can read PayPal's real payloads through the same code. */
export function toOrder(body: unknown): PaypalOrder {
  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) throw new PaypalError("unavailable", "unexpected_response");
  const units = parsed.data.purchase_units ?? [];
  const unit = units[0];
  const sellerId = unit?.payee?.merchant_id ?? null;
  return {
    id: parsed.data.id,
    stage: ORDER_STAGES.get(parsed.data.status) ?? "other",
    isCaptureIntent: parsed.data.intent === "CAPTURE",
    purchaseUnitCount: units.length,
    amount: unit ? fromPaypalValue(unit.amount.value) : null,
    currency: unit?.amount.currency_code ?? null,
    customId: unit?.custom_id ?? null,
    sellerId,
    approvalUrl: parsed.data.links?.find((link) => link.rel === "payer-action" || link.rel === "approve")?.href ?? null,
    captures: (unit?.payments?.captures ?? []).map((capture) => ({
      id: capture.id,
      state: CAPTURE_STATES.get(capture.status) ?? "other",
      amount: fromPaypalValue(capture.amount.value),
      currency: capture.amount.currency_code,
      customId: capture.custom_id ?? null,
      // A capture inside an order doesn't repeat the seller, so it comes from the order's purchase unit.
      sellerId: capture.payee?.merchant_id ?? sellerId,
    })),
  };
}

const readOrder = async (response: Response) => toOrder(await response.json().catch(() => null));

const orderHeaders = (requestId?: string): HeadersInit => ({
  Prefer: "return=representation",
  ...(requestId && { "PayPal-Request-Id": requestId }),
});

const orderPath = (orderId: string) => `/v2/checkout/orders/${encodeURIComponent(orderId)}`;

export type NewPaypalOrder = {
  requestId: string;
  customId: string;
  name: string;
  description: string | null;
  quantity: number;
  unitAmount: number;
  amount: number;
  currency: string;
  returnUrl: string;
  cancelUrl: string;
};

/** The same `requestId` returns the same order. An order nobody has approved can't charge anyone. */
export async function createOrder(session: PaypalSession, order: NewPaypalOrder): Promise<PaypalOrder> {
  const money = (minorUnits: number) => ({ currency_code: order.currency, value: toPaypalValue(minorUnits) });
  const response = await send(
    session.environment,
    "/v2/checkout/orders",
    authorized(session, {
      method: "POST",
      headers: orderHeaders(order.requestId),
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            custom_id: order.customId,
            amount: { ...money(order.amount), breakdown: { item_total: money(order.amount) } },
            items: [
              {
                name: order.name,
                ...(order.description && { description: order.description }),
                quantity: String(order.quantity),
                unit_amount: money(order.unitAmount),
              },
            ],
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: order.returnUrl,
              cancel_url: order.cancelUrl,
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
            },
          },
        },
      }),
    }),
  );
  return readOrder(response);
}

export async function getOrder(session: PaypalSession, orderId: string): Promise<PaypalOrder> {
  return readOrder(await send(session.environment, orderPath(orderId), authorized(session, { headers: orderHeaders() })));
}

/** The same `requestId` returns the same capture, and PayPal refuses a second capture of an order. */
export async function captureOrder(session: PaypalSession, orderId: string, requestId: string): Promise<PaypalOrder> {
  const response = await send(
    session.environment,
    `${orderPath(orderId)}/capture`,
    authorized(session, { method: "POST", headers: orderHeaders(requestId), body: "{}" }),
  );
  return readOrder(response);
}

const SIGNATURE_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
};

export const hasSignatureHeaders = (headers: Headers) => Object.values(SIGNATURE_HEADERS).every((name) => headers.get(name));

const verificationSchema = z.looseObject({ verification_status: z.string() });

/**
 * Asks PayPal whether this exact body was signed for this webhook. The body goes in as received,
 * because parsing and re-serializing could change the bytes that were signed.
 * Throws `unavailable` when PayPal can't answer, so the caller can have the event sent again.
 */
export async function verifyEvent(session: PaypalSession, webhookId: string, headers: Headers, rawBody: string): Promise<boolean> {
  const fields = Object.entries(SIGNATURE_HEADERS).map(([field, header]) => `${JSON.stringify(field)}:${JSON.stringify(headers.get(header))}`);
  try {
    const response = await send(
      session.environment,
      "/v1/notifications/verify-webhook-signature",
      authorized(session, {
        method: "POST",
        body: `{${fields.join(",")},"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${rawBody}}`,
      }),
    );
    return (await parse(response, verificationSchema)).verification_status === "SUCCESS";
  } catch (error) {
    // PayPal answers junk signature fields with this instead of FAILURE. Both mean "not verified".
    // Any other refusal, such as lost permission, is our fault, not a forged event, so PayPal should send it again.
    if (error instanceof PaypalError && error.code === "INVALID_REQUEST") return false;
    throw error;
  }
}
