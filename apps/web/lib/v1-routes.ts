import { hashApiKey } from "@billingrelay/core/secrets";
import { findActiveApiKey, type ActiveApiKey } from "@billingrelay/db";
import { apiError, readBodyUpTo } from "./api-response";

const MAX_BODY_BYTES = 64 * 1024;

const readBearerToken = (request: Request) => /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];

type ApiKeyHandler<C> = (args: { request: Request; apiKey: ActiveApiKey; context: C }) => Promise<Response>;

/** Wrap every /v1 route. `tests/e2e/admin-auth.test.ts` fails if a route doesn't. A session cookie means nothing here. */
export function withApiKey<C = unknown>(handler: ApiKeyHandler<C>) {
  return async (request: Request, context: C): Promise<Response> => {
    try {
      const token = readBearerToken(request);
      const apiKey = token ? await findActiveApiKey(hashApiKey(token)) : null;
      if (!apiKey) return apiError(401, "invalid_api_key", "Send a valid API key: Authorization: Bearer <key>");
      if (apiKey.environment !== "sandbox") return apiError(422, "live_disabled", "Live is not enabled");
      return await handler({ request, apiKey, context });
    } catch (error) {
      // Not the message: Drizzle's includes the query's parameters.
      console.error(`API route failed: ${error instanceof Error ? error.name : "unknown"}`);
      return apiError(500, "internal_error", "Something went wrong. Try again shortly.");
    }
  };
}

export const bodyTooLarge = () => apiError(413, "request_too_large", "The request body must be 64 KB or less");

/** Unparseable JSON comes back as null, for the schema to refuse. `null` as the result means the body was too large. */
export async function readJsonBody(request: Request): Promise<{ body: unknown } | null> {
  const text = await readBodyUpTo(request, MAX_BODY_BYTES);
  if (text === null) return null;
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { body: null };
  }
}
