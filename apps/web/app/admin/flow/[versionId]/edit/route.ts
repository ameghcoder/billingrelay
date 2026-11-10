import { flowEditSchema, applyFlowEdit } from "@billingrelay/core/flow";
import { getCatalogVersion, listCatalogVersions, recordAudit, saveCatalogVersion } from "@billingrelay/db";
import { apiError, invalidRequest, isUuid, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { catalogPorts } from "@/lib/billing-tools";

/**
 * One edit on the canvas saves a new version, built from the latest one: the same history as the catalog editor and the AI, and the
 * new version has no approval. Its config passes the same rules before it's saved.
 */
export const POST = withProject<{ params: Promise<{ versionId: string }> }>(async ({ request, projectId, operator, context }) => {
  const { versionId } = await context.params;
  const scope = sandboxScope(projectId);
  const version = isUuid(versionId) ? await getCatalogVersion(scope, versionId) : null;
  if (!version) return apiError(404, "not_found", "This version doesn't exist");
  const latest = (await listCatalogVersions(scope))[0]!;
  if (latest.id !== version.id) {
    return apiError(409, "version_conflict", "Only the latest version can be edited. Open it to make changes.", { latestVersion: latest.version });
  }

  const parsed = flowEditSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalidRequest(parsed.error);
  const edited = applyFlowEdit(version.config, parsed.data);
  if ("problem" in edited) {
    return edited.problem === "unchanged" ? apiError(422, "unchanged", "That's already the value") : apiError(404, "not_found", "No such setting in this version");
  }
  const checked = await catalogPorts(scope).checkProposal(edited.config);
  if (!checked.valid) return apiError(400, "invalid_config", "This change breaks a rule", { fields: checked.issues });

  const saved = await saveCatalogVersion({ ...scope, baseVersion: version.version, config: edited.config, createdBy: operator.id });
  if (saved.status === "conflict") return apiError(409, "version_conflict", "Someone saved a newer version first", { latestVersion: saved.latestVersion });
  await recordAudit({ projectId, actorKind: "operator", actorId: operator.id, action: "flow.edit", target: saved.id, detail: { from: version.version, version: saved.version, edit: parsed.data.type } });
  return jsonResponse({ id: saved.id, version: saved.version, approved: false }, 201);
});
