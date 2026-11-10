import { hashApiKey } from "@billingrelay/core/secrets";
import { findActiveApiKey } from "@billingrelay/db";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { apiError } from "@/lib/api-response";
import { createMcpServer } from "@/lib/mcp-server";
import { clientIp, limiter, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";

const readBearerToken = (request: Request) => /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];

/** Model Context Protocol over streamable HTTP, stateless: each request gets its own server, scoped to its key's project. */
async function handle(request: Request): Promise<Response> {
  try {
    const ip = clientIp(request.headers);
    const refusedSoFar = limiter.check(RATE_RULES.apiKeyRefusedPerIp, ip);
    if (!refusedSoFar.allowed) return tooManyRequests(refusedSoFar);
    const token = readBearerToken(request);
    const apiKey = token ? await findActiveApiKey(hashApiKey(token)) : null;
    if (!apiKey) {
      limiter.hit(RATE_RULES.apiKeyRefusedPerIp, ip);
      return apiError(401, "invalid_api_key", "Send an MCP key: Authorization: Bearer <key>");
    }
    if (apiKey.kind !== "mcp") return apiError(403, "wrong_key_kind", "This is a backend API key. /mcp needs an MCP key, created under Developers.");
    const perKey = limiter.hit(RATE_RULES.apiKey, apiKey.id);
    if (!perKey.allowed) return tooManyRequests(perKey);
    if (apiKey.environment !== "sandbox") return apiError(422, "live_disabled", "Live is not enabled");

    const server = createMcpServer(apiKey);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    console.error(`MCP route failed: ${error instanceof Error ? error.name : "unknown"}`);
    return apiError(500, "internal_error", "Something went wrong. Try again shortly.");
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
