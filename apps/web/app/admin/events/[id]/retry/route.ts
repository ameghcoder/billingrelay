import { recordAudit, retryByHand } from "@billingrelay/db";
import { apiError, isUuid, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";

/** A failed PayPal event is processed again, by hand. It only says where to look, so repeating it can't add anything. */
export const POST = withProject<{ params: Promise<{ id: string }> }>(async ({ projectId, operator, context }) => {
  const { id } = await context.params;
  const result = isUuid(id) ? await retryByHand(sandboxScope(projectId), "retry_event", id) : "not_found";
  if (result === "not_found") return apiError(404, "not_found", "No such event");
  if (result === "not_retryable") return apiError(409, "not_retryable", "Only a failed event can be retried");
  await recordAudit({ projectId, actorKind: "operator", actorId: operator.id, action: "event.retry", target: id });
  return jsonResponse({ id, status: "pending" });
});
