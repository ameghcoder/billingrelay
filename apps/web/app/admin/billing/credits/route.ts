import { creditListSchema, creditQuerySchema, queryOf } from "@billingrelay/core/dashboard";
import { listDashboardCredits } from "@billingrelay/db";
import { invalidRequest, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";

/** Each customer's credits as spending sees them now. */
export const GET = withProject(async ({ request, projectId }) => {
  const query = creditQuerySchema.safeParse(queryOf(request));
  if (!query.success) return invalidRequest(query.error);
  return jsonResponse(creditListSchema.parse(await listDashboardCredits(sandboxScope(projectId), query.data)));
});
