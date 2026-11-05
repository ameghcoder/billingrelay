import { z } from "zod";
import { nameSchema } from "./catalog";

export const createApiKeySchema = z.strictObject({ name: nameSchema });
export type CreateApiKey = z.infer<typeof createApiKeySchema>;

export const apiKeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  environment: z.enum(["sandbox", "live"]),
  lastFour: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>;

/** The only response that ever carries the full key. */
export const createdApiKeySchema = apiKeySummarySchema.extend({ key: z.string() });
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>;
