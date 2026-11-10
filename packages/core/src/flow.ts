import { z } from "zod";
import { formatPrice, nameSchema, priceSchema, refSchema, type CatalogConfig } from "./catalog";

// The flow is generated from a stored catalog version, never drawn by hand: what you see is what checkout does.

export const FLOW_STAGES = ["checkout", "paypal", "verified", "effects", "outbox", "destination"] as const;
export type FlowStage = (typeof FLOW_STAGES)[number];

export const flowEditSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("product_name"), productRef: z.string(), name: nameSchema }),
  z.strictObject({ type: z.literal("price"), productRef: z.string(), variantRef: z.string(), amount: priceSchema.shape.amount }),
  z.strictObject({
    type: z.literal("credits"),
    productRef: z.string(),
    variantRef: z.string(),
    amount: z.int({ error: "Must be a whole number of credits" }).positive("Must be more than 0").max(1_000_000_000),
  }),
  z.strictObject({ type: z.literal("access_key"), productRef: z.string(), variantRef: z.string(), key: refSchema }),
]);
export type FlowEdit = z.infer<typeof flowEditSchema>;

/** What changing a setting would save, and its value now. Settings without one are read-only. */
export type FlowSettingEdit = { type: FlowEdit["type"]; productRef: string; variantRef?: string; current: string | number };
export type FlowSetting = { label: string; value: string; edit?: FlowSettingEdit };

export type FlowStatus = { label: string; count: number; tone: "good" | "warn" | "bad" };

export type FlowNode = {
  id: string;
  stage: FlowStage;
  productRef: string;
  title: string;
  settings: FlowSetting[];
  status: FlowStatus[];
  position: { x: number; y: number };
};
export type FlowEdge = { id: string; source: string; target: string };
export type Flow = { nodes: FlowNode[]; edges: FlowEdge[] };

/** Recent counts per product, from our own tables. */
export type ProductActivity = { started: number; paid: number; unresolved: number; refunded: number; applied: number; delivered: number; failedDeliveries: number; activeSubscriptions: number };

const COLUMN = 260;
const ROW = 220;

export function buildFlow(config: CatalogConfig, options: { syncConfigured: boolean; activity?: Record<string, ProductActivity> }): Flow {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  config.products.forEach((product, row) => {
    const activity = options.activity?.[product.ref];
    const id = (stage: FlowStage) => `${product.ref}:${stage}`;
    const at = (stage: FlowStage) => ({ x: FLOW_STAGES.indexOf(stage) * COLUMN, y: row * ROW });
    const monthly = product.kind === "subscription";
    const node = (stage: FlowStage, title: string, settings: FlowSetting[], status: FlowStatus[] = []) =>
      nodes.push({ id: id(stage), stage, productRef: product.ref, title, settings, status: status.filter((item) => item.count > 0), position: at(stage) });

    node(
      "checkout",
      `Checkout: ${product.name}`,
      [
        { label: "Name", value: product.name, edit: { type: "product_name", productRef: product.ref, current: product.name } },
        { label: "Kind", value: product.kind.replace("_", " ") },
        ...product.variants.map((variant) => ({
          label: `Price, ${variant.name}`,
          value: `${formatPrice(variant.price.amount, variant.price.currency)}${monthly ? " / month" : ""}`,
          edit: { type: "price", productRef: product.ref, variantRef: variant.ref, current: variant.price.amount } satisfies FlowSettingEdit,
        })),
        ...(monthly ? [] : [{ label: "Most per purchase", value: String(product.maxQuantity) }]),
      ],
      [{ label: "started", count: activity?.started ?? 0, tone: "good" }],
    );
    node(
      "paypal",
      monthly ? "PayPal monthly plan" : "PayPal order, then capture",
      monthly
        ? [{ label: "Plan", value: "One per price, made on the first Pay" }, { label: "Renews", value: "Monthly; access runs 24h past each billing time" }]
        : [{ label: "Capture", value: "Once per order, by the server" }],
      [
        { label: "paid", count: activity?.paid ?? 0, tone: "good" },
        { label: "unresolved", count: activity?.unresolved ?? 0, tone: "warn" },
        { label: "refunded", count: activity?.refunded ?? 0, tone: "bad" },
      ],
    );
    node("verified", "Verified payment", [
      { label: "Webhook", value: "Signature verified with PayPal, stored before acknowledging" },
      { label: "Facts", value: "Re-read from PayPal; events only say where to look" },
    ]);
    node(
      "effects",
      "Effects",
      product.variants.flatMap((variant) =>
        variant.benefits.map((benefit): FlowSetting =>
          benefit.kind === "access"
            ? { label: `Access, ${variant.name}`, value: benefit.key, edit: { type: "access_key", productRef: product.ref, variantRef: variant.ref, current: benefit.key } }
            : {
                label: `${monthly ? "Monthly credits" : "Credits"}, ${variant.name}`,
                value: `${benefit.amount.toLocaleString("en-US")}${monthly ? " each paid month, no carry-over" : " per unit, never expire"}`,
                edit: { type: "credits", productRef: product.ref, variantRef: variant.ref, current: benefit.amount },
              },
        ),
      ).concat(product.variants.every((variant) => variant.benefits.length === 0) ? [{ label: "Grants", value: "Nothing: the payment only" }] : []),
      [
        { label: "applied", count: activity?.applied ?? 0, tone: "good" },
        { label: "active subscriptions", count: activity?.activeSubscriptions ?? 0, tone: "good" },
      ],
    );
    node("outbox", "Outbox", [{ label: "Written", value: "In the same transaction as each change" }]);
    node(
      "destination",
      options.syncConfigured ? "Your database" : "API only",
      options.syncConfigured
        ? [{ label: "Copy", value: "billingrelay.* tables, newer versions only" }]
        : [{ label: "Read", value: "GET /v1/customers/:id/billing" }],
      [
        { label: "delivered", count: activity?.delivered ?? 0, tone: "good" },
        { label: "failed deliveries", count: activity?.failedDeliveries ?? 0, tone: "bad" },
      ],
    );
    for (let i = 1; i < FLOW_STAGES.length; i++) {
      edges.push({ id: `${product.ref}:${i}`, source: id(FLOW_STAGES[i - 1]!), target: id(FLOW_STAGES[i]!) });
    }
  });
  return { nodes, edges };
}

export type FlowEditResult = { config: CatalogConfig } | { problem: "not_found" | "unchanged" };

/** The catalog with one setting changed, as a new document: the stored version is never touched. */
export function applyFlowEdit(config: CatalogConfig, edit: FlowEdit): FlowEditResult {
  const next = structuredClone(config);
  const product = next.products.find((candidate) => candidate.ref === edit.productRef);
  if (!product) return { problem: "not_found" };
  if (edit.type === "product_name") {
    if (product.name === edit.name) return { problem: "unchanged" };
    product.name = edit.name;
    return { config: next };
  }
  const variant = (product.variants as { ref: string; price: { amount: number }; benefits: { kind: string; key?: string; amount?: number }[] }[]).find(
    (candidate) => candidate.ref === edit.variantRef,
  );
  if (!variant) return { problem: "not_found" };
  if (edit.type === "price") {
    if (variant.price.amount === edit.amount) return { problem: "unchanged" };
    variant.price.amount = edit.amount;
    return { config: next };
  }
  const benefit = variant.benefits.find((candidate) => candidate.kind === (edit.type === "credits" ? "credits" : "access"));
  if (!benefit) return { problem: "not_found" };
  if (edit.type === "credits") {
    if (benefit.amount === edit.amount) return { problem: "unchanged" };
    benefit.amount = edit.amount;
  } else {
    if (benefit.key === edit.key) return { problem: "unchanged" };
    benefit.key = edit.key;
  }
  return { config: next };
}
