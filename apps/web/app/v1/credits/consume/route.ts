import { consumeRequestSchema, consumeResponseSchema } from "@billingrelay/core/credits";
import { consumeCredits } from "@billingrelay/db";
import { apiError, invalidRequest, jsonResponse } from "@/lib/api-response";
import { bodyTooLarge, readJsonBody, withApiKey } from "@/lib/v1-routes";

/** One debit per `usageId`: a retry gets the same answer, and spends at once can't take the same last credits. */
export const POST = withApiKey(async ({ request, apiKey }) => {
  const read = await readJsonBody(request);
  if (!read) return bodyTooLarge();
  const parsed = consumeRequestSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(parsed.error);

  const result = await consumeCredits(apiKey, parsed.data);
  if (result.status === "usage_conflict") {
    return apiError(409, "usage_conflict", "This usageId was already used for another customer or amount. Nothing was changed.");
  }
  if (result.status === "insufficient") {
    return apiError(422, "insufficient_credits", "Not enough credits. Nothing was debited.", { balance: result.balance });
  }
  return jsonResponse(consumeResponseSchema.parse({ usageId: parsed.data.usageId, debited: result.debited, balance: result.balance }));
});
