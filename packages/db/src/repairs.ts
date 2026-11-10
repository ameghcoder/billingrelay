import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { recordAudit } from "./audit";
import { getDb } from "./client";
import type { ProjectScope } from "./schema";
import { retrySyncNow } from "./sync";

type Runner = Pick<ReturnType<typeof getDb>, "execute">;

export const REPAIR_KINDS = ["retry_delivery", "retry_event", "retry_sync", "recheck_payment"] as const;
export type RepairKind = (typeof REPAIR_KINDS)[number];

/** Whether a repair applies to its target right now, and a fingerprint of the target's state to compare when it runs. */
export type RepairTarget = { eligible: boolean; state: string };

/**
 * Each kind's one rule. Only existing, duplicate-safe handlers: send a refused row again, process a failed event again, ask the
 * destination again, or ask PayPal again about a payment whose outcome isn't known. None of them can charge, refund or grant.
 */
export async function inspectRepairTarget(db: Runner, scope: ProjectScope, kind: RepairKind, targetId: string | null): Promise<RepairTarget | null> {
  if (kind === "retry_sync") {
    const { rows } = await db.execute<{ state: string; code: string | null; waiting: number }>(sql`
      SELECT s.state, s.code, (SELECT count(*)::int FROM outbox WHERE project_id = ${scope.projectId} AND status <> 'delivered') AS waiting
      FROM sync_status s WHERE s.id = 1`);
    const row = rows[0];
    if (!row) return null;
    return { eligible: row.state !== "not_configured" && (row.state !== "ok" || row.waiting > 0), state: `${row.state}:${row.code ?? "-"}` };
  }
  if (!targetId || !/^[0-9a-f-]{36}$/i.test(targetId)) return null;
  if (kind === "retry_delivery") {
    const { rows } = await db.execute<{ status: string; attempts: number; failure_code: string | null; source_version: number }>(sql`
      SELECT status, attempts, failure_code, source_version FROM outbox WHERE id = ${targetId} AND project_id = ${scope.projectId}`);
    const row = rows[0];
    if (!row) return null;
    return { eligible: row.status === "failed" || (row.status === "pending" && row.failure_code !== null), state: `${row.status}:${row.attempts}:${row.source_version}` };
  }
  if (kind === "retry_event") {
    const { rows } = await db.execute<{ status: string; attempts: number }>(sql`
      SELECT e.status, e.attempts FROM paypal_event e JOIN paypal_connection c ON c.id = e.connection_id
      WHERE e.id = ${targetId} AND c.project_id = ${scope.projectId} AND c.environment = ${scope.environment}`);
    const row = rows[0];
    if (!row) return null;
    return { eligible: row.status === "failed", state: `${row.status}:${row.attempts}` };
  }
  const { rows } = await db.execute<{ money_status: string; money_reason: string | null; source_version: number; paypal_order_id: string | null }>(sql`
    SELECT money_status, money_reason, source_version, paypal_order_id FROM checkout
    WHERE id = ${targetId} AND project_id = ${scope.projectId} AND environment = ${scope.environment}`);
  const row = rows[0];
  if (!row) return null;
  // Only a payment whose outcome isn't known: asking PayPal again never charges, and a settled one has nothing to learn.
  const unclear =
    row.paypal_order_id !== null &&
    ((row.money_status === "unresolved" && row.money_reason === "capture_outcome_unknown") || row.money_status === "approved" || row.money_status === "pending");
  return { eligible: unclear, state: `${row.money_status}:${row.money_reason ?? "-"}:${row.source_version}` };
}

export type RepairRecord = {
  id: string;
  kind: RepairKind;
  targetId: string | null;
  reason: string;
  status: "proposed" | "approved" | "executed" | "refused";
  outcome: string | null;
  createdAt: Date;
};

type RepairRow = { id: string; kind: RepairKind; target_id: string | null; reason: string; status: RepairRecord["status"]; outcome: string | null; created_at: string; target_state: string };

const toRepair = (row: RepairRow): RepairRecord => ({
  id: row.id,
  kind: row.kind,
  targetId: row.target_id,
  reason: row.reason,
  status: row.status,
  outcome: row.outcome,
  createdAt: new Date(row.created_at),
});

export async function getRepair(scope: ProjectScope, id: string): Promise<RepairRecord | null> {
  const { rows } = await getDb().execute<RepairRow>(sql`SELECT * FROM repair_action WHERE id = ${id} AND project_id = ${scope.projectId}`);
  return rows[0] ? toRepair(rows[0]) : null;
}

/** Stores a proposal only if it applies now. Null when it doesn't: the agent's proposal is dropped, not stored. */
export async function proposeRepair(
  scope: ProjectScope,
  proposal: { kind: RepairKind; targetId: string | null; reason: string; proposedBy: string },
): Promise<RepairRecord | null> {
  const target = await inspectRepairTarget(getDb(), scope, proposal.kind, proposal.targetId);
  if (!target?.eligible) return null;
  const { rows } = await getDb().execute<RepairRow>(sql`
    INSERT INTO repair_action (id, project_id, kind, target_id, target_state, reason, proposed_by)
    VALUES (${uuidv7()}, ${scope.projectId}, ${proposal.kind}, ${proposal.targetId}, ${target.state}, ${proposal.reason.slice(0, 500)}, ${proposal.proposedBy})
    RETURNING *`);
  await recordAudit({ projectId: scope.projectId, actorKind: "ai", actorId: proposal.proposedBy, action: "repair.propose", target: rows[0]!.id, detail: { kind: proposal.kind, targetId: proposal.targetId } });
  return toRepair(rows[0]!);
}

export async function approveRepair(scope: ProjectScope, id: string, operatorId: string): Promise<RepairRecord | null> {
  const { rows } = await getDb().execute<RepairRow>(sql`
    UPDATE repair_action SET status = 'approved', approved_by = ${operatorId}, approved_at = now()
    WHERE id = ${id} AND project_id = ${scope.projectId} AND status = 'proposed'
    RETURNING *`);
  if (rows[0]) await recordAudit({ projectId: scope.projectId, actorKind: "operator", actorId: operatorId, action: "repair.approve", target: id });
  return rows[0] ? toRepair(rows[0]) : getRepair(scope, id);
}

// The handlers, also used by hand from the dashboard. Each only puts a record back in line for the code that already handles it.

/** A refused or waiting delivery goes again now. The destination still only takes a newer version. */
export async function retryDelivery(db: Runner, outboxId: string): Promise<boolean> {
  const { rows } = await db.execute(sql`
    UPDATE outbox SET status = 'pending', attempts = 0, failure_code = NULL, next_attempt_at = now()
    WHERE id = ${outboxId} AND status IN ('failed', 'pending')
    RETURNING id`);
  await db.execute(sql`UPDATE sync_status SET next_try_at = now(), updated_at = now() WHERE id = 1`);
  return rows.length > 0;
}

/** A failed event is processed again: it only ever says where to look, so repeating it can't add anything. */
export async function retryEvent(db: Runner, eventId: string): Promise<boolean> {
  const { rows } = await db.execute(sql`
    UPDATE paypal_event SET status = 'pending', attempts = 0, failure_code = NULL, next_attempt_at = now()
    WHERE id = ${eventId} AND status = 'failed'
    RETURNING id`);
  return rows.length > 0;
}

export type ExecuteResult = { status: "executed"; outcome: string } | { status: "stale" } | { status: "not_approved" } | { status: "not_found" };

/**
 * Runs an approved repair once. The row lock and the status make a second run do nothing; the fingerprint makes a proposal whose
 * target changed since (delivered, retried, settled) refuse instead of acting on a situation that no longer exists.
 */
export async function executeRepair(
  scope: ProjectScope,
  id: string,
  operatorId: string,
  recheckPayment: (checkoutId: string) => Promise<void>,
): Promise<ExecuteResult> {
  const claimed = await getDb().transaction(async (tx): Promise<ExecuteResult | { run: RepairRow }> => {
    const { rows } = await tx.execute<RepairRow>(sql`SELECT * FROM repair_action WHERE id = ${id} AND project_id = ${scope.projectId} FOR UPDATE`);
    const repair = rows[0];
    if (!repair) return { status: "not_found" };
    if (repair.status !== "approved") return repair.status === "proposed" ? { status: "not_approved" } : { status: "stale" };
    const target = await inspectRepairTarget(tx, scope, repair.kind, repair.target_id);
    // A sync retry is harmless whatever the state: if the database recovered meanwhile, it only ends waits that are left.
    const stillApplies = repair.kind === "retry_sync" ? target !== null : target?.eligible === true && target.state === repair.target_state;
    if (!stillApplies) {
      await tx.execute(sql`UPDATE repair_action SET status = 'refused', outcome = 'stale', executed_at = now() WHERE id = ${id}`);
      return { status: "stale" };
    }
    let outcome = "queued";
    if (repair.kind === "retry_delivery") outcome = (await retryDelivery(tx, repair.target_id!)) ? "delivery_queued" : "nothing_to_do";
    if (repair.kind === "retry_event") outcome = (await retryEvent(tx, repair.target_id!)) ? "event_queued" : "nothing_to_do";
    await tx.execute(sql`UPDATE repair_action SET status = 'executed', outcome = ${outcome}, executed_at = now() WHERE id = ${id}`);
    return repair.kind === "retry_sync" || repair.kind === "recheck_payment" ? { run: repair } : { status: "executed", outcome };
  });
  if (!("run" in claimed)) {
    if (claimed.status === "executed") await recordAudit({ projectId: scope.projectId, actorKind: "operator", actorId: operatorId, action: "repair.execute", target: id, detail: { outcome: claimed.outcome } });
    return claimed;
  }
  // Outside the row lock: these talk to the destination's queue or to PayPal.
  let outcome: string;
  if (claimed.run.kind === "retry_sync") outcome = `sync_retried:${(await retrySyncNow()).requeued}`;
  else {
    await recheckPayment(claimed.run.target_id!);
    outcome = "payment_rechecked";
  }
  await getDb().execute(sql`UPDATE repair_action SET outcome = ${outcome} WHERE id = ${id}`);
  await recordAudit({ projectId: scope.projectId, actorKind: "operator", actorId: operatorId, action: "repair.execute", target: id, detail: { outcome } });
  return { status: "executed", outcome };
}

/**
 * Every record's latest change goes to the destination again: for a new or rebuilt merchant database. The destination keeps only
 * newer versions, so running it on a full one changes nothing there.
 */
export async function resendEverything(scope: ProjectScope): Promise<number> {
  const { rows } = await getDb().execute(sql`
    UPDATE outbox o SET status = 'pending', attempts = 0, failure_code = NULL, next_attempt_at = now(), delivered_at = NULL
    FROM (
      SELECT DISTINCT ON (entity_type, entity_id) id FROM outbox WHERE project_id = ${scope.projectId}
      ORDER BY entity_type, entity_id, source_version DESC
    ) latest
    WHERE o.id = latest.id
    RETURNING o.id`);
  await getDb().execute(sql`UPDATE sync_status SET next_try_at = now(), updated_at = now() WHERE id = 1`);
  return rows.length;
}

export type ReconcileCounts = { unconfirmedOrders: number; benefitsPending: number; failedEvents: number; failedDeliveries: number };

/** What reconciliation is looking at, with the payment ones moved to the front of the worker's queue. */
export async function reconcileNow(scope: ProjectScope): Promise<ReconcileCounts> {
  const db = getDb();
  const { rows } = await db.execute<{ unconfirmed: number; benefits: number }>(sql`
    WITH due AS (
      UPDATE checkout SET next_check_at = now()
      WHERE project_id = ${scope.projectId} AND environment = ${scope.environment} AND fulfillment_status = 'pending'
        AND ((money_status = 'pending' AND paypal_order_id IS NOT NULL AND capture_requested_at IS NULL AND expires_at > now())
             OR money_status = 'captured')
      RETURNING money_status
    )
    SELECT count(*) FILTER (WHERE money_status = 'pending')::int AS unconfirmed, count(*) FILTER (WHERE money_status = 'captured')::int AS benefits FROM due`);
  const { rows: failed } = await db.execute<{ events: number; deliveries: number }>(sql`
    SELECT (SELECT count(*)::int FROM paypal_event e JOIN paypal_connection c ON c.id = e.connection_id WHERE c.project_id = ${scope.projectId} AND e.status = 'failed') AS events,
           (SELECT count(*)::int FROM outbox WHERE project_id = ${scope.projectId} AND status = 'failed') AS deliveries`);
  return { unconfirmedOrders: rows[0]!.unconfirmed, benefitsPending: rows[0]!.benefits, failedEvents: failed[0]!.events, failedDeliveries: failed[0]!.deliveries };
}

export type ByHandResult = "retried" | "not_found" | "not_retryable";

/** The dashboard's own retry buttons: the same handlers, the same rule for what can be retried, no AI involved. */
export async function retryByHand(scope: ProjectScope, kind: "retry_delivery" | "retry_event", id: string): Promise<ByHandResult> {
  const target = await inspectRepairTarget(getDb(), scope, kind, id);
  if (!target) return "not_found";
  if (!target.eligible) return "not_retryable";
  if (kind === "retry_delivery") await retryDelivery(getDb(), id);
  else await retryEvent(getDb(), id);
  return "retried";
}
