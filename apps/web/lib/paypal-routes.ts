import { getDefaultProjectId } from "@billingrelay/db";
import { withOperator } from "./operator";

export type EnvironmentContext = { params: Promise<{ environment: string }> };

const NO_STORE = { "Cache-Control": "no-store" };

export const jsonResponse = (body: unknown) => Response.json(body, { headers: NO_STORE });

export const apiError = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  Response.json({ error: { code, message, ...(details && { details }) } }, { status, headers: NO_STORE });

type Handler<C> = (args: { request: Request; projectId: string; context: C }) => Promise<Response>;

/** Operator-only, with one seeded project. Failures log only the error's type. */
export function withProject<C>(handler: Handler<C>) {
  return withOperator<C>(async (request, context) => {
    try {
      const projectId = await getDefaultProjectId();
      if (!projectId) return apiError(500, "project_not_seeded", "Run pnpm db:seed to create the project");
      return await handler({ request, projectId, context });
    } catch (error) {
      // Not the message: Drizzle's includes the query's parameters.
      console.error(`PayPal connection route failed: ${error instanceof Error ? error.name : "unknown"}`);
      return apiError(500, "internal_error", "Something went wrong. Try again shortly.");
    }
  });
}

/** Sandbox is the only environment that can be used; live is refused before any PayPal call. */
export function withSandbox(handler: Handler<EnvironmentContext>) {
  return withProject<EnvironmentContext>(async (args) => {
    const { environment } = await args.context.params;
    if (environment === "live") return apiError(422, "live_disabled", "Live payments are disabled in this sandbox project");
    if (environment !== "sandbox") return apiError(404, "not_found", "Unknown environment");
    return handler(args);
  });
}
