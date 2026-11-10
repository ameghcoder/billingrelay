import { CHECKOUT_LIFETIME_SECONDS, parseCheckoutRequest, returnOriginOf } from "@billingrelay/core/checkouts";
import { hashPayload, idempotencyKeySchema } from "@billingrelay/core/idempotency";
import { buildQuoteSnapshot, refuseQuoteUse, type QuoteSnapshot } from "@billingrelay/core/quotes";
import {
  createCheckout,
  findCheckoutByKey,
  findCheckoutIdByQuote,
  getActiveCatalog,
  getCheckout,
  getPaypalConnection,
  getQuote,
  isReturnOriginAllowed,
  type CheckoutRecord,
  type ProjectScope,
} from "@billingrelay/db";
import { apiError, invalidRequest, jsonResponse } from "@/lib/api-response";
import { toCheckoutResponse } from "@/lib/checkout";
import { publicOrigin } from "@/lib/paypal-connection";
import { bodyTooLarge, readJsonBody, withApiKey } from "@/lib/v1-routes";

async function replay(stored: CheckoutRecord & { payloadHash: string }, payloadHash: string) {
  if (stored.payloadHash !== payloadHash) {
    return apiError(409, "idempotency_conflict", "This Idempotency-Key was used with a different request. Nothing was changed.");
  }
  return jsonResponse(await toCheckoutResponse(stored));
}

const quoteUsed = (checkoutId: string) =>
  apiError(409, "quote_used", "This quote already has a checkout. Create a new quote to try again.", { checkoutId });

async function fixedPrice(scope: ProjectScope, request: Exclude<ReturnType<typeof parseCheckoutRequest>["data"], undefined>) {
  if (!("quoteId" in request)) {
    const built = buildQuoteSnapshot(request, await getActiveCatalog(scope), { allowSubscription: true });
    return "refusal" in built ? { failure: apiError(422, built.refusal.code, built.refusal.message) } : { snapshot: built.snapshot };
  }

  const quote = await getQuote(scope, request.quoteId);
  if (!quote) return { failure: apiError(404, "not_found", "No such quote") };
  const refusal = refuseQuoteUse(quote, request.externalCustomerId);
  if (refusal) return { failure: apiError(422, refusal.code, refusal.message) };
  const usedBy = await findCheckoutIdByQuote(scope, quote.id);
  if (usedBy) return { failure: quoteUsed(usedBy) };
  return { snapshot: quote.snapshot };
}

export const POST = withApiKey(async ({ request, apiKey }) => {
  const { id: apiKeyId, ...scope } = apiKey;

  const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!idempotencyKey.success) {
    return apiError(400, "idempotency_key_required", "Send an Idempotency-Key header: 1 to 255 printable characters, no spaces");
  }

  const read = await readJsonBody(request);
  if (!read) return bodyTooLarge();
  const parsed = parseCheckoutRequest(read.body);
  if (!parsed.success) return invalidRequest(parsed.error);
  const payloadHash = hashPayload(parsed.data);

  const stored = await findCheckoutByKey(scope, idempotencyKey.data);
  if (stored) return replay(stored, payloadHash);

  const priced: { failure: Response } | { snapshot: QuoteSnapshot } = await fixedPrice(scope, parsed.data);
  if ("failure" in priced) return priced.failure;

  const origin = returnOriginOf(parsed.data.returnUrl);
  if (!origin || !(await isReturnOriginAllowed(scope, origin))) {
    return apiError(422, "return_url_not_allowed", "Add this returnUrl's origin under Developers, in Allowed return URLs");
  }

  const connection = await getPaypalConnection(scope.projectId, scope.environment);
  // Capabilities survive a failed check. Refuse here, because a checkout that can't be paid would use up its quote for good.
  const cantLogIn = connection?.lastCheck === "credentials_rejected" || connection?.lastCheck === "secret_unreadable";
  if (!connection?.capabilities?.checkout || cantLogIn) return apiError(422, "paypal_not_connected", "Connect PayPal, with the checkout capability, first");
  if (priced.snapshot.product.kind === "subscription" && !connection.capabilities.subscriptions) {
    return apiError(422, "paypal_not_connected", "This PayPal app doesn't have the subscriptions capability");
  }
  if (!publicOrigin()) return apiError(422, "public_url_invalid", "PUBLIC_BASE_URL must be an https URL");

  const quoteId = "quoteId" in parsed.data ? parsed.data.quoteId : null;
  const created = await createCheckout({
    ...scope,
    apiKeyId,
    externalCustomerId: parsed.data.externalCustomerId,
    quoteId,
    idempotencyKey: idempotencyKey.data,
    payloadHash,
    returnUrl: parsed.data.returnUrl,
    snapshot: priced.snapshot,
    lifetimeSeconds: CHECKOUT_LIFETIME_SECONDS,
  });
  if (created.status === "created") return jsonResponse(await toCheckoutResponse((await getCheckout(scope, created.id))!), 201);
  if (created.status === "subscription_exists") {
    return apiError(409, "subscription_exists", "This customer already has this subscription, or is starting it", { checkoutId: created.checkoutId });
  }

  // Another request got in after the lookups above, with this key or for this quote.
  const winner = await findCheckoutByKey(scope, idempotencyKey.data);
  if (winner) return replay(winner, payloadHash);
  const usedBy = quoteId && (await findCheckoutIdByQuote(scope, quoteId));
  if (usedBy) return quoteUsed(usedBy);
  throw new Error("Checkout missing after a conflict");
});
