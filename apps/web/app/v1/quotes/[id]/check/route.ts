import { checkQuoteRequestSchema, refuseQuoteUse } from "@billingrelay/core/quotes";
import { getQuote } from "@billingrelay/db";
import { apiError, invalidRequest, isUuid, jsonResponse } from "@/lib/api-response";
import { toQuoteResponse } from "@/lib/quotes";
import { bodyTooLarge, readJsonBody, withApiKey } from "@/lib/v1-routes";

const notFound = () => apiError(404, "not_found", "This quote doesn't exist");

export const POST = withApiKey<{ params: Promise<{ id: string }> }>(async ({ request, apiKey, context }) => {
  const { id } = await context.params;
  if (!isUuid(id)) return notFound();

  const read = await readJsonBody(request);
  if (!read) return bodyTooLarge();
  const parsed = checkQuoteRequestSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(parsed.error);

  const quote = await getQuote(apiKey, id);
  if (!quote) return notFound();

  const refusal = refuseQuoteUse(quote, parsed.data.externalCustomerId);
  if (refusal) return apiError(422, refusal.code, refusal.message);
  return jsonResponse(toQuoteResponse(quote));
});
