import { createApiKeySchema } from "@billingrelay/core/api-keys";
import { generateApiKey } from "@billingrelay/core/secrets";
import { createApiKey, listApiKeys } from "@billingrelay/db";
import { invalidRequest, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { toApiKeySummary } from "@/lib/api-keys";

export const GET = withProject(async ({ projectId }) => {
  const keys = await listApiKeys(sandboxScope(projectId));
  return jsonResponse({ keys: keys.map(toApiKeySummary) });
});

export const POST = withProject(async ({ request, projectId, operator }) => {
  const body = createApiKeySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return invalidRequest(body.error);

  const scope = sandboxScope(projectId);
  const { key, keyHash, lastFour } = generateApiKey(scope.environment, body.data.kind);
  const record = await createApiKey({ ...scope, name: body.data.name, kind: body.data.kind, keyHash, lastFour, createdBy: operator.id });
  return jsonResponse({ ...toApiKeySummary(record), key }, 201);
});
