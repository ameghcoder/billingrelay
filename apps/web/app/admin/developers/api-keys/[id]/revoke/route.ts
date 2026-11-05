import { revokeApiKey } from "@billingrelay/db";
import { apiError, isUuid, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { toApiKeySummary } from "@/lib/api-keys";

export const POST = withProject<{ params: Promise<{ id: string }> }>(async ({ projectId, context }) => {
  const { id } = await context.params;
  const record = isUuid(id) ? await revokeApiKey(sandboxScope(projectId), id) : null;
  if (!record) return apiError(404, "not_found", "This API key doesn't exist");
  return jsonResponse(toApiKeySummary(record));
});
