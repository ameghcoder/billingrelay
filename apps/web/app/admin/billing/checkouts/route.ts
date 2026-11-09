import { listDashboardCheckouts } from "@billingrelay/db";
import { invalidRequest, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { checkoutListSchema, checkoutQuerySchema, queryOf } from "@billingrelay/core/dashboard";

/** Filtered and paged in SQL. Totals are per currency, over every matching checkout, not just this page. */
export const GET = withProject(async ({ request, projectId }) => {
  const query = checkoutQuerySchema.safeParse(queryOf(request));
  if (!query.success) return invalidRequest(query.error);
  const { limit, offset, ...filters } = query.data;
  return jsonResponse(checkoutListSchema.parse(await listDashboardCheckouts(sandboxScope(projectId), filters, { limit, offset })));
});
