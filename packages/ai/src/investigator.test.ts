import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { runInvestigation } from "./investigator";

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const call = (toolName: string, input: unknown, id = toolName): GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: "tool_calls" },
  usage,
  warnings: [],
});

const ports = { getCustomerTrace: async () => ({ checkouts: [{ id: "c1", sync: "failed" }] }), getSyncStatus: async () => ({ destination: { state: "not_ready", code: "permission_denied" } }) };
const report = {
  facts: [{ text: "The payment was captured", evidence: ["c1"] }],
  inference: "The merchant database refused the worker's role.",
  uncertainty: "Whether the permission was removed on purpose.",
  proposal: { kind: "retry_sync", targetId: null, reason: "Changes wait for the database." },
  operatorStep: "Grant billingrelay_sync its permissions back.",
};

describe("runInvestigation", () => {
  it("reads the trace and status, then ends with one report", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [call("get_customer_trace", {}), call("get_sync_status", {}), call("report", report), call("report", report, "again")] });
    const result = await runInvestigation({ model, ports, question: "Why is Pro missing in my database?" });
    expect(result.toolCalls).toEqual(["get_customer_trace", "get_sync_status", "report"]);
    expect(result.report).toEqual(report);
    expect(model.doGenerateCalls).toHaveLength(3);
  });

  it("a proposal outside the fixed list never becomes a report", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [call("report", { ...report, proposal: { kind: "refund", targetId: "c1", reason: "x" } }), call("report", { ...report, proposal: null }, "fixed")],
    });
    const result = await runInvestigation({ model, ports, question: "Refund them" });
    expect(result.report?.proposal).toBeNull();
  });

  it("no report after the step limit is no report", async () => {
    const model = new MockLanguageModelV4({ doGenerate: Array.from({ length: 10 }, (_, i) => call("get_customer_trace", {}, `t${i}`)) });
    expect((await runInvestigation({ model, ports, question: "?" })).report).toBeNull();
  });
});
