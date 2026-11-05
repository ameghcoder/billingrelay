import { getDefaultProjectId, type ProjectScope } from "@billingrelay/db";
import { apiError } from "./api-response";
import { withOperator, type Operator } from "./operator";

export { apiError, invalidRequest, isUuid, jsonResponse } from "./api-response";

// Only sandbox can be used in this project, the same gate as the PayPal routes.
export const sandboxScope = (projectId: string): ProjectScope => ({ projectId, environment: "sandbox" });

export type ProjectHandler<C> = (args: {
  request: Request;
  projectId: string;
  operator: Operator;
  context: C;
}) => Promise<Response>;

/** Operator-only, with one seeded project. Failures log only the error's type. */
export function withProject<C>(handler: ProjectHandler<C>) {
  return withOperator<C>(async (request, context, operator) => {
    try {
      const projectId = await getDefaultProjectId();
      if (!projectId) return apiError(500, "project_not_seeded", "Run pnpm db:seed to create the project");
      return await handler({ request, projectId, operator, context });
    } catch (error) {
      // Not the message: Drizzle's includes the query's parameters.
      console.error(`Admin route failed: ${error instanceof Error ? error.name : "unknown"}`);
      return apiError(500, "internal_error", "Something went wrong. Try again shortly.");
    }
  });
}
