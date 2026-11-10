import { z } from "zod";
import { nameSchema } from "./catalog";

// `backend`: the merchant's server, on /v1. `mcp`: an AI client, on /mcp only. Neither works on the other's endpoint.
export const API_KEY_KINDS = ["backend", "mcp"] as const;
export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

export const createApiKeySchema = z.strictObject({ name: nameSchema, kind: z.enum(API_KEY_KINDS).default("backend") });
export type CreateApiKey = z.input<typeof createApiKeySchema>;

export const apiKeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  environment: z.enum(["sandbox", "live"]),
  kind: z.enum(API_KEY_KINDS),
  lastFour: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>;

/** The only response that ever carries the full key. */
export const createdApiKeySchema = apiKeySummarySchema.extend({ key: z.string() });
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>;
