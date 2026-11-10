import { recordAudit, resendEverything } from "@billingrelay/db";
import { jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";

/** Every record's latest change goes to the merchant's database again, for a new or rebuilt one. It keeps only newer versions. */
export const POST = withProject(async ({ projectId, operator }) => {
  const requeued = await resendEverything(sandboxScope(projectId));
  await recordAudit({ projectId, actorKind: "operator", actorId: operator.id, action: "sync.resend", detail: { requeued } });
  return jsonResponse({ requeued });
});
