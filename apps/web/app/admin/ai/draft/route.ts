import { configuredModel, runCatalogAgent } from "@billingrelay/ai";
import { aiDraftRequestSchema, aiDraftResponseSchema, diffCatalog, type AiDraftResponse } from "@billingrelay/core/ai-setup";
import { hashPayload } from "@billingrelay/core/idempotency";
import { getActiveCatalog, recordAudit } from "@billingrelay/db";
import { apiError, invalidRequest, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { catalogPorts } from "@/lib/billing-tools";
import { limiter, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";

const RUN_TIMEOUT_MS = 60_000;

/** The AI drafts; nothing is saved. The operator saves the proposal as a version, approves it, and makes it live. */
export const POST = withProject(async ({ request, projectId, operator }) => {
  const decision = limiter.hit(RATE_RULES.aiDraft, operator.id);
  if (!decision.allowed) return tooManyRequests(decision);
  const parsed = aiDraftRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalidRequest(parsed.error);

  const model = configuredModel();
  if (!model) return apiError(503, "ai_unavailable", "AI setup isn't configured. The catalog editor works without it.");

  const scope = sandboxScope(projectId);
  let response: AiDraftResponse;
  let toolCalls: string[] = [];
  try {
    const result = await runCatalogAgent({
      model,
      ports: catalogPorts(scope),
      message: parsed.data.message,
      history: parsed.data.history,
      abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    toolCalls = result.toolCalls;
    if (result.outcome === "proposal") {
      const live = await getActiveCatalog(scope);
      const config = result.config as { products: { ref: string }[] };
      response = { outcome: "proposal", config, note: result.note, diff: diffCatalog(config, live?.config ?? null), liveVersion: live?.version ?? null };
    } else {
      response = result.outcome === "questions" ? { outcome: "questions", questions: result.questions } : { outcome: "no_proposal", note: result.note, issues: result.issues };
    }
  } catch (error) {
    console.warn(`AI draft failed: ${error instanceof Error ? error.name : "unknown"}`);
    return apiError(503, "ai_unavailable", "The AI model didn't answer. Try again, or use the catalog editor.");
  }

  // Never the prompt: it's the operator's text and could hold anything. What was decided, and a hash to match the saved version.
  await recordAudit({
    projectId,
    actorKind: "ai",
    actorId: operator.id,
    action: "ai.draft",
    detail: { outcome: response.outcome, toolCalls, ...(response.outcome === "proposal" && { proposalHash: hashPayload(response.config) }) },
  });
  return jsonResponse(aiDraftResponseSchema.parse(response));
});
