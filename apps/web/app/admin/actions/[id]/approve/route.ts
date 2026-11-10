import { approveRepair } from "@billingrelay/db";
import { apiError, isUuid, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { toRepair } from "@/lib/repairs";

/** A person approves one proposed repair. It still has to apply when it runs. */
export const POST = withProject<{ params: Promise<{ id: string }> }>(async ({ projectId, operator, context }) => {
  const { id } = await context.params;
  const repair = isUuid(id) ? await approveRepair(sandboxScope(projectId), id, operator.id) : null;
  if (!repair) return apiError(404, "not_found", "No such repair");
  return jsonResponse(toRepair(repair));
});
