import { activateCatalogVersion } from "@billingrelay/db";
import { apiError, jsonResponse, withProject } from "@/lib/admin-routes";
import { catalogScope, checkForActivation, isVersionId } from "@/lib/catalog";

export const POST = withProject<{ params: Promise<{ id: string }> }>(async ({ projectId, operator, context }) => {
  const { id } = await context.params;
  if (!isVersionId(id)) return apiError(404, "not_found", "This version doesn't exist");

  const result = await activateCatalogVersion({
    ...catalogScope(projectId),
    versionId: id,
    activatedBy: operator.id,
    check: checkForActivation,
  });

  if (result.status === "not_found") return apiError(404, "not_found", "This version doesn't exist");
  if (result.status === "rejected") {
    return apiError(422, "config_rejected", "This version can't go live. What's live hasn't changed.", { fields: result.issues });
  }
  return jsonResponse({ id, version: result.version, isLive: true });
});
