import { listDashboardEvents } from "@billingrelay/db";
import { invalidRequest, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { eventListSchema, eventQuerySchema, queryOf } from "@billingrelay/core/dashboard";

/** Stored PayPal events: type, status, attempts and failure code. Never the payload, which names the buyer. */
export const GET = withProject(async ({ request, projectId }) => {
  const query = eventQuerySchema.safeParse(queryOf(request));
  if (!query.success) return invalidRequest(query.error);
  const { limit, offset, ...filters } = query.data;
  return jsonResponse(eventListSchema.parse(await listDashboardEvents(sandboxScope(projectId), filters, { limit, offset })));
});
