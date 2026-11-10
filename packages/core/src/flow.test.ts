import { describe, expect, it } from "vitest";
import { catalogConfigSchema } from "./catalog";
import { applyFlowEdit, buildFlow, flowEditSchema, FLOW_STAGES } from "./flow";

const config = catalogConfigSchema.parse({
  products: [
    {
      ref: "pro",
      name: "Pro",
      kind: "subscription",
      variants: [{ ref: "monthly", name: "Monthly", price: { amount: 1900, currency: "USD" }, benefits: [{ kind: "access", key: "pro" }, { kind: "credits", amount: 2000 }] }],
    },
    { ref: "pack", name: "Pack", kind: "credit_pack", variants: [{ ref: "d", name: "1,000", price: { amount: 500, currency: "USD" }, benefits: [{ kind: "credits", amount: 1000 }] }] },
    { ref: "poster", name: "Poster", kind: "one_time", variants: [{ ref: "d", name: "Default", price: { amount: 300, currency: "EUR" }, benefits: [] }] },
  ],
});

describe("buildFlow", () => {
  it("draws one lane per product through every stage, joined in order", () => {
    const flow = buildFlow(config, { syncConfigured: true });
    expect(flow.nodes).toHaveLength(3 * FLOW_STAGES.length);
    expect(flow.edges).toHaveLength(3 * (FLOW_STAGES.length - 1));
    expect(flow.edges.filter((edge) => edge.id.startsWith("pro:")).map((edge) => `${edge.source}>${edge.target}`)).toEqual([
      "pro:checkout>pro:paypal",
      "pro:paypal>pro:verified",
      "pro:verified>pro:effects",
      "pro:effects>pro:outbox",
      "pro:outbox>pro:destination",
    ]);
  });

  it("shows each product's real settings, and only the four editable kinds can be edited", () => {
    const flow = buildFlow(config, { syncConfigured: false });
    const node = (id: string) => flow.nodes.find((candidate) => candidate.id === id)!;
    expect(node("pro:checkout").settings.find((setting) => setting.label === "Price, Monthly")).toMatchObject({ value: "$19.00 / month", edit: { type: "price", current: 1900 } });
    expect(node("pro:paypal").title).toBe("PayPal monthly plan");
    expect(node("pack:paypal").title).toBe("PayPal order, then capture");
    expect(node("pro:effects").settings.map((setting) => setting.value)).toEqual(["pro", "2,000 each paid month, no carry-over"]);
    expect(node("pack:effects").settings[0]).toMatchObject({ value: "1,000 per unit, never expire", edit: { type: "credits", current: 1000 } });
    expect(node("poster:effects").settings).toEqual([{ label: "Grants", value: "Nothing: the payment only" }]);
    expect(node("poster:destination").title).toBe("API only");
    const editable = flow.nodes.flatMap((n) => n.settings.filter((setting) => setting.edit)).map((setting) => setting.edit!.type);
    expect(new Set(editable)).toEqual(new Set(["product_name", "price", "credits", "access_key"]));
  });

  it("puts recent activity on the nodes it belongs to, hiding zeros", () => {
    const flow = buildFlow(config, {
      syncConfigured: true,
      activity: { pack: { started: 4, paid: 3, unresolved: 1, refunded: 0, applied: 3, delivered: 3, failedDeliveries: 0, activeSubscriptions: 0 } },
    });
    expect(flow.nodes.find((n) => n.id === "pack:paypal")!.status).toEqual([
      { label: "paid", count: 3, tone: "good" },
      { label: "unresolved", count: 1, tone: "warn" },
    ]);
    expect(flow.nodes.find((n) => n.id === "pro:paypal")!.status).toEqual([]);
  });
});

describe("applyFlowEdit", () => {
  it("changes exactly one setting in a new document, leaving the stored one alone", () => {
    const before = JSON.stringify(config);
    const result = applyFlowEdit(config, { type: "price", productRef: "pro", variantRef: "monthly", amount: 2500 });
    expect("config" in result && result.config.products[0]!.variants[0]!.price.amount).toBe(2500);
    expect(JSON.stringify(config)).toBe(before);
    if ("config" in result) expect(catalogConfigSchema.safeParse(result.config).success).toBe(true);
  });

  it.each([
    [{ type: "product_name", productRef: "pack", name: "Big pack" }, (c: typeof config) => c.products[1]!.name, "Big pack"],
    [{ type: "credits", productRef: "pro", variantRef: "monthly", amount: 3000 }, (c: typeof config) => (c.products[0]!.variants[0]!.benefits[1] as { amount: number }).amount, 3000],
    [{ type: "access_key", productRef: "pro", variantRef: "monthly", key: "pro-plus" }, (c: typeof config) => (c.products[0]!.variants[0]!.benefits[0] as { key: string }).key, "pro-plus"],
  ] as const)("edits %j", (edit, read, expected) => {
    const result = applyFlowEdit(config, edit as never);
    expect("config" in result && read(result.config)).toBe(expected);
  });

  it("says when there's nothing to change or nothing to find", () => {
    expect(applyFlowEdit(config, { type: "price", productRef: "pro", variantRef: "monthly", amount: 1900 })).toEqual({ problem: "unchanged" });
    expect(applyFlowEdit(config, { type: "price", productRef: "nope", variantRef: "monthly", amount: 1 })).toEqual({ problem: "not_found" });
    expect(applyFlowEdit(config, { type: "credits", productRef: "poster", variantRef: "d", amount: 5 })).toEqual({ problem: "not_found" });
  });

  it("refuses anything but the four edits, and bad values", () => {
    expect(flowEditSchema.safeParse({ type: "kind", productRef: "pro", kind: "one_time" }).success).toBe(false);
    expect(flowEditSchema.safeParse({ type: "price", productRef: "pro", variantRef: "monthly", amount: 19.5 }).success).toBe(false);
    expect(flowEditSchema.safeParse({ type: "access_key", productRef: "pro", variantRef: "monthly", key: "Has Spaces" }).success).toBe(false);
  });
});
