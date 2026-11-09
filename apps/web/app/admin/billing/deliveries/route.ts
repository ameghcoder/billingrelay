import { listDashboardDeliveries } from "@billingrelay/db";
import { invalidRequest, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { deliveryListSchema, deliveryQuerySchema, queryOf } from "@billingrelay/core/dashboard";

/** Outbox rows with their last attempt and lag. Read from our own database, never the destination. */
export const GET = withProject(async ({ request, projectId }) => {
  const query = deliveryQuerySchema.safeParse(queryOf(request));
  if (!query.success) return invalidRequest(query.error);
  const { limit, offset, ...filters } = query.data;
  return jsonResponse(deliveryListSchema.parse(await listDashboardDeliveries(sandboxScope(projectId), filters, { limit, offset })));
});
