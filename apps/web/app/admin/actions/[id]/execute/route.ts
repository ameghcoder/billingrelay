import { recheckPayment } from "@billingrelay/billing";
import { executeRepair, getRepair } from "@billingrelay/db";
import { apiError, isUuid, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { toRepair } from "@/lib/repairs";

/** Rechecks that the approved repair still applies to its record exactly as proposed, runs it once, and records what happened. */
export const POST = withProject<{ params: Promise<{ id: string }> }>(async ({ projectId, operator, context }) => {
  const { id } = await context.params;
  const scope = sandboxScope(projectId);
  if (!isUuid(id)) return apiError(404, "not_found", "No such repair");
  const result = await executeRepair(scope, id, operator.id, recheckPayment);
  if (result.status === "not_found") return apiError(404, "not_found", "No such repair");
  if (result.status === "not_approved") return apiError(409, "not_approved", "Approve this repair first");
  if (result.status === "stale") return apiError(409, "stale_action", "The record changed since this was proposed, or it already ran. Investigate again.");
  return jsonResponse(toRepair((await getRepair(scope, id))!));
});
