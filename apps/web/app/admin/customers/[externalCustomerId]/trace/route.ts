import { customerTraceSchema } from "@billingrelay/core/dashboard";
import { externalCustomerIdSchema } from "@billingrelay/core/quotes";
import { getCustomerTrace } from "@billingrelay/db";
import { apiError, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";

/** One customer's checkouts and everything that followed each one, in time order. */
export const GET = withProject<{ params: Promise<{ externalCustomerId: string }> }>(async ({ projectId, context }) => {
  const { externalCustomerId } = await context.params;
  const id = externalCustomerIdSchema.safeParse(externalCustomerId);
  const trace = id.success ? await getCustomerTrace(sandboxScope(projectId), id.data) : null;
  if (!trace) return apiError(404, "not_found", "No such customer");
  return jsonResponse(customerTraceSchema.parse(trace));
});
