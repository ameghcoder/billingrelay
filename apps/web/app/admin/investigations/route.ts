import { configuredModel, runInvestigation } from "@billingrelay/ai";
import { investigationRequestSchema, investigationResponseSchema } from "@billingrelay/core/repairs";
import { getCustomerTrace, getSyncOverview, proposeRepair, recordAudit } from "@billingrelay/db";
import { apiError, invalidRequest, jsonResponse, sandboxScope, withProject } from "@/lib/admin-routes";
import { limiter, RATE_RULES, tooManyRequests } from "@/lib/rate-limit";
import { targetInTrace, toRepair } from "@/lib/repairs";

const RUN_TIMEOUT_MS = 60_000;

/** The AI reads one customer's trace and the sync status, explains, and may propose one existing repair. Nothing runs until approved. */
export const POST = withProject(async ({ request, projectId, operator }) => {
  const decision = limiter.hit(RATE_RULES.aiInvestigate, operator.id);
  if (!decision.allowed) return tooManyRequests(decision);
  const parsed = investigationRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return invalidRequest(parsed.error);
  const model = configuredModel();
  if (!model) return apiError(503, "ai_unavailable", "AI isn't configured. The trace and the retry buttons work without it.");

  const scope = sandboxScope(projectId);
  const trace = await getCustomerTrace(scope, parsed.data.externalCustomerId);
  if (!trace) return apiError(404, "not_found", "No such customer");

  let result;
  try {
    result = await runInvestigation({
      model,
      question: parsed.data.question,
      // Codes, statuses and IDs only: the trace never carries payloads, emails or metadata.
      ports: { getCustomerTrace: async () => trace, getSyncStatus: async () => getSyncOverview() },
      abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(`AI investigation failed: ${error instanceof Error ? error.name : "unknown"}`);
    return apiError(503, "ai_unavailable", "The AI model didn't answer. The trace and the retry buttons still work.");
  }

  const proposal = result.report?.proposal ?? null;
  let action = null;
  let proposalDropped: string | null = null;
  if (proposal) {
    if (!targetInTrace(trace, proposal.kind, proposal.targetId)) proposalDropped = "It named a record that isn't in this customer's trace.";
    else {
      action = await proposeRepair(scope, { ...proposal, proposedBy: operator.id });
      // A row that's only waiting because the database refuses everything: the repair for that is retrying the sync itself.
      if (!action && proposal.kind === "retry_delivery") {
        action = await proposeRepair(scope, { kind: "retry_sync", targetId: null, reason: proposal.reason, proposedBy: operator.id });
      }
      if (!action) proposalDropped = "It doesn't apply now: the record isn't in a state that repair is for.";
    }
  }
  await recordAudit({
    projectId,
    actorKind: "ai",
    actorId: operator.id,
    action: "ai.investigate",
    detail: { toolCalls: result.toolCalls, proposal: proposal?.kind ?? null, dropped: proposalDropped !== null, actionId: action?.id ?? null },
  });
  const report = result.report && { facts: result.report.facts, inference: result.report.inference, uncertainty: result.report.uncertainty, operatorStep: result.report.operatorStep };
  return jsonResponse(investigationResponseSchema.parse({ report, action: action && toRepair(action), proposalDropped }));
});
