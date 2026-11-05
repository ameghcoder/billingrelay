import { z } from "zod";

export const savePaypalConnectionSchema = z.strictObject({
  clientId: z.string().trim().min(1, "Enter the client ID").max(256),
  clientSecret: z.string().trim().min(1, "Enter the secret").max(256),
});
export type SavePaypalConnection = z.infer<typeof savePaypalConnectionSchema>;

export const paypalCheckResultSchema = z.enum([
  "ok",
  "credentials_rejected",
  "paypal_unreachable",
  "secret_unreadable",
  "webhook_missing",
  "capability_missing",
]);
export type PaypalCheckResult = z.infer<typeof paypalCheckResultSchema>;

export const paypalWebhookErrorSchema = z.enum([
  "public_url_invalid",
  "webhook_rejected",
  "paypal_unreachable",
  "webhook_missing",
]);
export type PaypalWebhookError = z.infer<typeof paypalWebhookErrorSchema>;

/** What the browser may see. It has no field for the secret, so parsing drops anything extra. */
export const paypalConnectionViewSchema = z.object({
  environment: z.enum(["sandbox", "live"]),
  clientId: z.string(),
  secretStored: z.literal(true),
  webhook: z.object({
    status: z.enum(["registered", "not_registered"]),
    url: z.string().nullable(),
    error: paypalWebhookErrorSchema.nullable(),
  }),
  capabilities: z
    .object({ checkout: z.boolean(), subscriptions: z.boolean(), webhooks: z.boolean() })
    .nullable(),
  lastCheck: paypalCheckResultSchema.nullable(),
  lastCheckedAt: z.string().nullable(),
});
export type PaypalConnectionView = z.infer<typeof paypalConnectionViewSchema>;
