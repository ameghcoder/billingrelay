import { repairSchema, type Repair } from "@billingrelay/core/repairs";
import type { CustomerTrace, RepairKind, RepairRecord } from "@billingrelay/db";

export const toRepair = (record: RepairRecord): Repair => repairSchema.parse({ ...record, createdAt: record.createdAt.toISOString() });

/** A proposal may only name a record this customer's trace shows: the model can't point a retry at someone else's row. */
export function targetInTrace(trace: CustomerTrace, kind: RepairKind, targetId: string | null): boolean {
  if (kind === "retry_sync") return targetId === null;
  if (!targetId) return false;
  if (kind === "recheck_payment") return trace.checkouts.some((checkout) => checkout.id === targetId);
  return trace.checkouts.some((checkout) =>
    checkout.steps.some((step) => (kind === "retry_delivery" ? step.kind === "outbox" && step.outboxId === targetId : step.kind === "event" && step.eventId === targetId)),
  );
}
