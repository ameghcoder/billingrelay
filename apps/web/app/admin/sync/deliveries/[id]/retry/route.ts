import { recordAudit, retryByHand } from "@billingrelay/db";
import { apiError, isUuid, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";

/** One failed or refused delivery goes again now, by hand. The destination still only takes a newer version. */
export const POST = withProject<{ params: Promise<{ id: string }> }>(async ({ projectId, operator, context }) => {
  const { id } = await context.params;
  const result = isUuid(id) ? await retryByHand(sandboxScope(projectId), "retry_delivery", id) : "not_found";
  if (result === "not_found") return apiError(404, "not_found", "No such delivery");
  if (result === "not_retryable") return apiError(409, "not_retryable", "Only a failed or refused delivery can be retried");
  await recordAudit({ projectId, actorKind: "operator", actorId: operator.id, action: "sync.retry_delivery", target: id });
  return jsonResponse({ id, status: "pending" });
});
