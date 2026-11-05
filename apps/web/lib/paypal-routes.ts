import { apiError, withProject, type ProjectHandler } from "./admin-routes";

export type EnvironmentContext = { params: Promise<{ environment: string }> };

/** Sandbox is the only environment that can be used; live is refused before any PayPal call. */
export function withSandbox(handler: ProjectHandler<EnvironmentContext>) {
  return withProject<EnvironmentContext>(async (args) => {
    const { environment } = await args.context.params;
    if (environment === "live") return apiError(422, "live_disabled", "Live payments are disabled in this sandbox project");
    if (environment !== "sandbox") return apiError(404, "not_found", "Unknown environment");
    return handler(args);
  });
}
