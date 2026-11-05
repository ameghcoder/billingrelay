import { getCatalogVersion } from "@billingrelay/db";
import { apiError, jsonResponse, withProject } from "@/lib/admin-routes";
import { catalogScope, isVersionId, toDetail } from "@/lib/catalog";

export const GET = withProject<{ params: Promise<{ id: string }> }>(async ({ projectId, context }) => {
  const { id } = await context.params;
  const record = isVersionId(id) ? await getCatalogVersion(catalogScope(projectId), id) : null;
  if (!record) return apiError(404, "not_found", "This version doesn't exist");
  return jsonResponse(toDetail(record));
});
