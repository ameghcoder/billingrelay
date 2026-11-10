import { approveCatalogVersion } from "@billingrelay/db";
import { apiError, isUuid, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";

/** A person approves this exact version. Only the dashboard can do this: neither the AI agent nor MCP has a way to. */
export const POST = withProject<{ params: Promise<{ id: string }> }>(async ({ projectId, operator, context }) => {
  const { id } = await context.params;
  const result = isUuid(id) ? await approveCatalogVersion({ ...sandboxScope(projectId), versionId: id, approvedBy: operator.id }) : { status: "not_found" as const };
  if (result.status === "not_found") return apiError(404, "not_found", "This version doesn't exist");
  return jsonResponse({ id, version: result.version, approved: true });
});
