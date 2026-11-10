import { subscriptionListSchema, subscriptionQuerySchema, queryOf } from "@billingrelay/core/dashboard";
import { listDashboardSubscriptions } from "@billingrelay/db";
import { invalidRequest, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";

/** Subscriptions with what PayPal last said and how long access lasts. */
export const GET = withProject(async ({ request, projectId }) => {
  const query = subscriptionQuerySchema.safeParse(queryOf(request));
  if (!query.success) return invalidRequest(query.error);
  const { limit, offset, ...filters } = query.data;
  return jsonResponse(subscriptionListSchema.parse(await listDashboardSubscriptions(sandboxScope(projectId), filters, { limit, offset })));
});
