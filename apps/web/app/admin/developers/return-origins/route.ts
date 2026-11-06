import { addReturnOriginSchema } from "@billingrelay/core/checkouts";
import { addReturnOrigin, listReturnOrigins } from "@billingrelay/db";
import { invalidRequest, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { toReturnOriginSummary } from "@/lib/checkout-admin";

export const GET = withProject(async ({ projectId }) => {
  const origins = await listReturnOrigins(sandboxScope(projectId));
  return jsonResponse({ origins: origins.map(toReturnOriginSummary) });
});

export const POST = withProject(async ({ request, projectId, operator }) => {
  const body = addReturnOriginSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return invalidRequest(body.error);

  await addReturnOrigin({ ...sandboxScope(projectId), origin: body.data.origin, createdBy: operator.id });
  return jsonResponse({ origin: body.data.origin }, 201);
});
