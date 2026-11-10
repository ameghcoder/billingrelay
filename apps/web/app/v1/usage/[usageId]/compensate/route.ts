import { compensateResponseSchema, usageIdSchema } from "@billingrelay/core/credits";
import { compensateUsage } from "@billingrelay/db";
import { apiError, jsonResponse } from "@/lib/api-response";
import { withApiKey } from "@/lib/v1-routes";

type Context = { params: Promise<{ usageId: string }> };

/** Gives a failed usage's credits back, once. A repeat returns the same answer. */
export const POST = withApiKey<Context>(async ({ apiKey, context }) => {
  const usageId = usageIdSchema.safeParse((await context.params).usageId);
  const result = usageId.success ? await compensateUsage(apiKey, usageId.data) : { status: "not_found" as const };
  if (result.status === "not_found") return apiError(404, "not_found", "No debit with this usageId");
  return jsonResponse(compensateResponseSchema.parse({ usageId: usageId.data, compensated: result.compensated, balance: result.balance }));
});
