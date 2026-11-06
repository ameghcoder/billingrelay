import { removeReturnOrigin } from "@billingrelay/db";
import { apiError, isUuid, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";

export const DELETE = withProject<{ params: Promise<{ id: string }> }>(async ({ projectId, context }) => {
  const { id } = await context.params;
  if (!isUuid(id)) return apiError(404, "not_found", "No such origin");
  await removeReturnOrigin(sandboxScope(projectId), id);
  return jsonResponse({ removed: true });
});
