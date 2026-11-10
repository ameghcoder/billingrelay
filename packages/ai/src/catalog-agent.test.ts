import { catalogConfigSchema, toFieldIssues } from "@billingrelay/core/catalog";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { findUnstatedAmounts, runCatalogAgent, statedNumbers, type CatalogPorts } from "./catalog-agent";

// A scripted model: each step is what "the model" says next. The tools, validation and loop are the real ones.
type LanguageModelV4GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const call = (toolName: string, input: unknown, id = toolName): LanguageModelV4GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: "tool_calls" },
  usage,
  warnings: [],
});
const say = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: "stop" },
  usage,
  warnings: [],
});

const ports = (live: unknown = null): CatalogPorts & { checked: unknown[] } => {
  const checked: unknown[] = [];
  return {
    checked,
    readLiveCatalog: async () => (live ? { version: 3, config: live } : null),
    checkProposal: async (config) => {
      checked.push(config);
      const parsed = catalogConfigSchema.safeParse(config);
      return parsed.success ? { valid: true, config: parsed.data } : { valid: false, issues: toFieldIssues(parsed.error) };
    },
  };
};

const pro = {
  ref: "pro",
  name: "Pro",
  kind: "subscription",
  variants: [{ ref: "monthly", name: "Monthly", attributes: {}, price: { amount: 1900, currency: "USD" }, benefits: [{ kind: "access", key: "pro" }, { kind: "credits", amount: 2000 }] }],
};
const pack = {
  ref: "credits-1000",
  name: "1,000 credits",
  kind: "credit_pack",
  variants: [{ ref: "default", name: "1,000 credits", attributes: {}, price: { amount: 500, currency: "USD" }, benefits: [{ kind: "credits", amount: 1000 }] }],
};

describe("runCatalogAgent", () => {
  it("reads, gets told what's wrong, fixes it, and returns the one valid proposal", async () => {
    // A pack that grants nothing: the schema says what's wrong, and the model fixes it.
    const wrong = { ...pack, variants: [{ ...pack.variants[0], benefits: [] }] };
    const model = new MockLanguageModelV4({
      doGenerate: [
        call("read_live_catalog", {}),
        call("propose_catalog", { config: { products: [pro, wrong] } }, "p1"),
        call("propose_catalog", { config: { products: [pro, pack] } }, "p2"),
        say("Pro is $19 a month with 2,000 monthly credits; the pack is $5 for 1,000 credits that never expire."),
      ],
    });
    const fake = ports();
    const result = await runCatalogAgent({ model, ports: fake, message: "A $19 monthly plan with 2,000 credits and a $5 pack of 1,000." });

    expect(result.outcome).toBe("proposal");
    expect(result.toolCalls).toEqual(["read_live_catalog", "propose_catalog", "propose_catalog"]);
    expect(fake.checked).toHaveLength(2);
    if (result.outcome !== "proposal") return;
    expect(catalogConfigSchema.parse(result.config).products.map((product) => product.ref)).toEqual(["pro", "credits-1000"]);
    // The model was told exactly what was wrong the first time.
    const toolResults = JSON.stringify(model.doGenerateCalls[2]!.prompt);
    expect(toolResults).toContain("benefits");
  });

  it("asks instead of guessing when a price is missing", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [call("ask_operator", { questions: ["What should the monthly plan cost?"] }), say("I need the price first.")],
    });
    const result = await runCatalogAgent({ model, ports: ports(), message: "A monthly plan with credits." });
    expect(result).toMatchObject({ outcome: "questions", questions: ["What should the monthly plan cost?"] });
  });

  it("no valid proposal comes back as such, with the last issues", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [call("propose_catalog", { config: { products: [{ ...pack, kind: "rental" }] } }), say("I couldn't make that work.")],
    });
    const result = await runCatalogAgent({ model, ports: ports(), message: "Rent my bikes by the hour." });
    expect(result.outcome).toBe("no_proposal");
    if (result.outcome === "no_proposal") expect(result.issues.length).toBeGreaterThan(0);
  });

  it("stops after a fixed number of steps, however long the model keeps going", async () => {
    const model = new MockLanguageModelV4({ doGenerate: Array.from({ length: 20 }, (_, i) => call("read_live_catalog", {}, `r${i}`)) });
    const result = await runCatalogAgent({ model, ports: ports(), message: "anything" });
    expect(model.doGenerateCalls.length).toBe(6);
    expect(result.outcome).toBe("no_proposal");
  });

  it("sends the rules as the system prompt and earlier turns before the new message", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [say("ok")] });
    await runCatalogAgent({
      model,
      ports: ports(),
      message: "Make it $25.",
      history: [
        { role: "user", content: "A monthly plan." },
        { role: "assistant", content: "What should it cost?" },
      ],
    });
    const prompt = model.doGenerateCalls[0]!.prompt;
    expect(prompt[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(prompt[0])).toContain("never guess");
    expect(prompt.slice(1).map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("findUnstatedAmounts", () => {
  it("reads $19, 19.00, 2,000 and 1000 the way people write them", () => {
    const { money, plain } = statedNumbers(["$19 a month with 2,000 credits", "and 19.50 for a pack of 1000"]);
    expect([...money]).toEqual(expect.arrayContaining([1900, 1950, 200000, 100000]));
    expect([...plain]).toEqual(expect.arrayContaining([19, 2000, 1000]));
  });

  it("flags a price or credit amount nobody wrote, in a new product", () => {
    const issues = findUnstatedAmounts({ products: [pro] }, null, ["A monthly Pro plan with 2,000 credits"]);
    expect(issues.map((issue) => issue.path)).toEqual(["products.0.variants.0.price.amount"]);
    expect(findUnstatedAmounts({ products: [pro] }, null, ["$19 a month, 2,000 credits"])).toEqual([]);
  });

  it("leaves live products that didn't change alone, but checks one that did", () => {
    expect(findUnstatedAmounts({ products: [pro, pack] }, { products: [pro] }, ["Add a $5 pack of 1,000 credits"])).toEqual([]);
    const repriced = { ...pro, variants: [{ ...pro.variants[0], price: { amount: 2500, currency: "USD" } }] };
    expect(findUnstatedAmounts({ products: [repriced] }, { products: [pro] }, ["Make Pro cheaper"]).map((issue) => issue.path)).toEqual(["products.0.variants.0.price.amount"]);
    expect(findUnstatedAmounts({ products: [repriced] }, { products: [pro] }, ["Make Pro $25"])).toEqual([]);
  });

  it("a price copied from another product doesn't count as stated", async () => {
    const team = { ...pro, ref: "team", name: "Team", variants: [{ ...pro.variants[0], benefits: [{ kind: "access", key: "team" }] }] };
    const model = new MockLanguageModelV4({
      doGenerate: [call("propose_catalog", { config: { products: [pro, team] } }), call("ask_operator", { questions: ["What should Team cost?"] }, "a")],
    });
    const result = await runCatalogAgent({ model, ports: ports({ products: [pro] }), message: "Add a monthly Team plan with team access." });
    expect(result).toMatchObject({ outcome: "questions" });
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("didn't state this price");
  });
});
