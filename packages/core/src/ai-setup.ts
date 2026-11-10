import { z } from "zod";
import type { FieldIssue } from "./catalog";

const turnSchema = z.strictObject({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) });

export const aiDraftRequestSchema = z.strictObject({
  message: z.string({ error: "Describe what you sell" }).trim().min(1, "Describe what you sell").max(2000, "Up to 2,000 characters"),
  // Earlier turns of this conversation, so an answer to a question has its context. The browser keeps them.
  history: z.array(turnSchema).max(12).default([]),
});
export type AiDraftRequest = z.input<typeof aiDraftRequestSchema>;

export type CatalogDiff = { added: string[]; changed: string[]; removed: string[] };

export const aiDraftResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("proposal"),
    config: z.unknown(),
    note: z.string(),
    // Against what's live now, by product ref.
    diff: z.object({ added: z.array(z.string()), changed: z.array(z.string()), removed: z.array(z.string()) }),
    liveVersion: z.number().nullable(),
  }),
  z.object({ outcome: z.literal("questions"), questions: z.array(z.string()) }),
  z.object({ outcome: z.literal("no_proposal"), note: z.string(), issues: z.array(z.custom<FieldIssue>()) }),
]);
export type AiDraftResponse = z.infer<typeof aiDraftResponseSchema>;

type ProductLike = { ref: string };

/** Which products a proposal adds, changes or drops, compared with what's live. */
export function diffCatalog(next: { products: ProductLike[] }, live: { products: ProductLike[] } | null): CatalogDiff {
  const before = new Map((live?.products ?? []).map((product) => [product.ref, JSON.stringify(product)]));
  const after = new Map(next.products.map((product) => [product.ref, JSON.stringify(product)]));
  return {
    added: [...after.keys()].filter((ref) => !before.has(ref)),
    changed: [...after.keys()].filter((ref) => before.has(ref) && before.get(ref) !== after.get(ref)),
    removed: [...before.keys()].filter((ref) => !after.has(ref)),
  };
}
