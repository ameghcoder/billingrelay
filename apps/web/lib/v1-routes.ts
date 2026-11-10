import { hashApiKey } from "@billingrelay/core/secrets";
import { findActiveApiKey, type ActiveApiKey } from "@billingrelay/db";
import { apiError, readBodyUpTo } from "./api-response";
import { clientIp, limiter, RATE_RULES, tooManyRequests } from "./rate-limit";

const MAX_BODY_BYTES = 64 * 1024;

const readBearerToken = (request: Request) => /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];

type ApiKeyHandler<C> = (args: { request: Request; apiKey: ActiveApiKey; context: C }) => Promise<Response>;

/** Wrap every /v1 route. `tests/e2e/admin-auth.test.ts` fails if a route doesn't. A session cookie means nothing here. */
export function withApiKey<C = unknown>(handler: ApiKeyHandler<C>) {
  return async (request: Request, context: C): Promise<Response> => {
    try {
      const ip = clientIp(request.headers);
      const refusedSoFar = limiter.check(RATE_RULES.apiKeyRefusedPerIp, ip);
      if (!refusedSoFar.allowed) return tooManyRequests(refusedSoFar);

      const token = readBearerToken(request);
      const apiKey = token ? await findActiveApiKey(hashApiKey(token)) : null;
      if (!apiKey) {
        limiter.hit(RATE_RULES.apiKeyRefusedPerIp, ip);
        return apiError(401, "invalid_api_key", "Send a valid API key: Authorization: Bearer <key>");
      }
      // An MCP key drafts catalogs; it can't take payments or read billing here.
      if (apiKey.kind !== "backend") return apiError(403, "wrong_key_kind", "This is an MCP key. Use it on /mcp; /v1 needs a backend API key.");
      const perKey = limiter.hit(RATE_RULES.apiKey, apiKey.id);
      if (!perKey.allowed) return tooManyRequests(perKey);
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
