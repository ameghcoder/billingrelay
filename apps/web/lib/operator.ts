import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth } from "./auth";

export type Operator = { id: string; email: string };

export const getOperator = cache(async (): Promise<Operator | null> => {
  // headers() must run first: it marks the page dynamic, so `next build` won't prerender it.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  return session ? { id: session.user.id, email: session.user.email } : null;
});

/**
 * Call in every /admin page as well as the layout. Next doesn't re-run layouts on
 * client navigation, so a layout check alone wouldn't catch an expired session.
 */
export async function requireOperatorPage(): Promise<Operator> {
  const operator = await getOperator();
  if (!operator) redirect("/login");
  return operator;
}

type OperatorHandler<C> = (request: Request, context: C, operator: Operator) => Promise<Response> | Response;

/** Wrap every /admin API route. `tests/e2e/admin-auth.test.ts` fails if a route doesn't. */
export function withOperator<C = unknown>(handler: OperatorHandler<C>) {
  return async (request: Request, context: C): Promise<Response> => {
    const operator = await getOperator();
    if (!operator) {
      return Response.json(
        { error: { code: "unauthorized", message: "Sign in to continue" } },
        { status: 401 },
      );
    }
    return handler(request, context, operator);
  };
}
