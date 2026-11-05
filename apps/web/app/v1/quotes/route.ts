import { hashPayload, idempotencyKeySchema } from "@billingrelay/core/idempotency";
import { buildQuoteSnapshot, parseQuoteRequest } from "@billingrelay/core/quotes";
import { createQuote, findQuoteByKey, getActiveCatalog, type QuoteRecord } from "@billingrelay/db";
import { apiError, invalidRequest, jsonResponse } from "@/lib/api-response";
import { toQuoteResponse } from "@/lib/quotes";
import { bodyTooLarge, readJsonBody, withApiKey } from "@/lib/v1-routes";

function replay(stored: QuoteRecord & { payloadHash: string }, payloadHash: string) {
  if (stored.payloadHash !== payloadHash) {
    return apiError(409, "idempotency_conflict", "This Idempotency-Key was used with a different request. Nothing was changed.");
  }
  return jsonResponse(toQuoteResponse(stored));
}

export const POST = withApiKey(async ({ request, apiKey }) => {
  const { id: apiKeyId, ...scope } = apiKey;

  const idempotencyKey = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!idempotencyKey.success) {
    return apiError(400, "idempotency_key_required", "Send an Idempotency-Key header: 1 to 255 printable characters, no spaces");
  }

  const read = await readJsonBody(request);
  if (!read) return bodyTooLarge();
  const parsed = parseQuoteRequest(read.body);
  if (!parsed.success) return invalidRequest(parsed.error);
  const payloadHash = hashPayload(parsed.data);

  const stored = await findQuoteByKey(scope, idempotencyKey.data);
  if (stored) return replay(stored, payloadHash);

  const built = buildQuoteSnapshot(parsed.data, await getActiveCatalog(scope));
  if ("refusal" in built) return apiError(422, built.refusal.code, built.refusal.message);

  const created = await createQuote({
    ...scope,
    apiKeyId,
    externalCustomerId: parsed.data.externalCustomerId,
    idempotencyKey: idempotencyKey.data,
    payloadHash,
    snapshot: built.snapshot,
    expiresInSeconds: parsed.data.expiresInSeconds,
  });
  if (created) return jsonResponse(toQuoteResponse(created), 201);

  // Another request with this key committed after the lookup above.
  const winner = await findQuoteByKey(scope, idempotencyKey.data);
  if (!winner) throw new Error("Quote missing after an idempotency conflict");
  return replay(winner, payloadHash);
});
