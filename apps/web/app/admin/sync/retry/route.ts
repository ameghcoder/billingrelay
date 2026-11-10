import { recordAudit, retrySyncNow } from "@billingrelay/db";
import { jsonResponse, withProject } from "@/lib/admin-routes";

/** Ends every wait now: failed deliveries go back in line and the merchant's database is checked on the next pass. */
export const POST = withProject(async ({ projectId, operator }) => {
  const result = await retrySyncNow();
  await recordAudit({ projectId, actorKind: "operator", actorId: operator.id, action: "sync.retry", detail: result });
  return jsonResponse(result);
});
