import { findKindChanges, saveCatalogDraftSchema, toFieldIssues, type FieldIssue } from "@billingrelay/core/catalog";
import { getActiveCatalog, listCatalogVersions, saveCatalogVersion } from "@billingrelay/db";
import { apiError, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { toSummary } from "@/lib/catalog";

const invalidConfig = (fields: FieldIssue[]) => apiError(400, "invalid_config", "The catalog has errors", { fields });

export const GET = withProject(async ({ projectId }) => {
  const versions = await listCatalogVersions(sandboxScope(projectId));
  return jsonResponse({ versions: versions.map(toSummary) });
});

export const POST = withProject(async ({ request, projectId, operator }) => {
  const body = saveCatalogDraftSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return invalidConfig(toFieldIssues(body.error));

  const scope = sandboxScope(projectId);
  const live = await getActiveCatalog(scope);
  const kindChanges = findKindChanges(body.data.config, live?.config ?? null);
  if (kindChanges.length > 0) {
    return invalidConfig(kindChanges.map((issue) => ({ ...issue, path: `config.${issue.path}` })));
  }

  const result = await saveCatalogVersion({ ...scope, ...body.data, createdBy: operator.id });
  if (result.status === "conflict") {
    return apiError(409, "version_conflict", "Someone saved a newer version first. Nothing was saved. Reload and try again.", {
      latestVersion: result.latestVersion,
    });
  }
  return jsonResponse({ id: result.id, version: result.version }, 201);
});
