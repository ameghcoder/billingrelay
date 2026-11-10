import { z } from "zod";
import { externalCustomerIdSchema } from "./quotes";

export const REPAIR_KINDS = ["retry_delivery", "retry_event", "retry_sync", "recheck_payment"] as const;

export const investigationRequestSchema = z.strictObject({
  externalCustomerId: externalCustomerIdSchema,
  question: z.string().trim().min(1).max(500).default("Why is this customer's billing not right in my database?"),
});
export type InvestigationRequest = z.input<typeof investigationRequestSchema>;

export const repairSchema = z.object({
  id: z.string(),
  kind: z.enum(REPAIR_KINDS),
  targetId: z.string().nullable(),
  reason: z.string(),
  status: z.enum(["proposed", "approved", "executed", "refused"]),
  outcome: z.string().nullable(),
  createdAt: z.string(),
});
export type Repair = z.infer<typeof repairSchema>;

export const investigationResponseSchema = z.object({
  report: z
    .object({
      facts: z.array(z.object({ text: z.string(), evidence: z.array(z.string()) })),
      inference: z.string(),
      uncertainty: z.string(),
      operatorStep: z.string().nullable(),
    })
    .nullable(),
  // Stored only when the proposal names a record in this customer's trace and applies right now.
  action: repairSchema.nullable(),
  proposalDropped: z.string().nullable(),
});
export type InvestigationResponse = z.infer<typeof investigationResponseSchema>;
