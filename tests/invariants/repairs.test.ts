// Repair and reconciliation invariants against real Postgres, with no PayPal or model. Writes rows, so only on a throwaway database
// with no worker running.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveRepair,
  claimUnconfirmedOrder,
  closePools,
  executeRepair,
  proposeRepair,
  resendEverything,
  retryByHand,
} from "../../packages/db/src/index";
import { getSourcePool } from "../../packages/db/src/client";

const db = () => getSourcePool();
const one = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) => (await db().query(text, values)).rows[0] as T;

describe.runIf(process.env.E2E_WRITE_DB === "1")("repair invariants", { timeout: 60_000 }, () => {
  let scope: { projectId: string; environment: "sandbox" };
  let otherScope: { projectId: string; environment: "sandbox" };
  let apiKeyId: string;
  let customerId: string;
  let connectionId: string;
  const noRecheck = async () => {
    throw new Error("PayPal isn't called in these tests");
  };

  const checkout = async (values: { money?: string; order?: string | null; ago?: string; expiresIn?: string } = {}) => {
    const id = randomUUID();
    const snapshot = { source: "merchant", catalogVersion: null, product: { ref: "p", name: "P", kind: "one_time" }, variant: null, quantity: 1, unitAmount: 100, amount: 100, currency: "USD", benefits: [], metadata: {} };
    await db().query(
      `INSERT INTO checkout (id, project_id, environment, customer_id, api_key_id, idempotency_key, payload_hash, return_url, snapshot, expires_at, money_status, paypal_order_id, created_at)
       VALUES ($1, $2, 'sandbox', $3, $4, $5, 'x', 'https://a.example/r', $6, now() + $7::interval, $8, $9, now() - $10::interval)`,
      [id, scope.projectId, customerId, apiKeyId, `rep-${id}`, JSON.stringify(snapshot), values.expiresIn ?? "1 hour", values.money ?? "pending", values.order ?? null, values.ago ?? "0 seconds"],
    );
    return id;
  };
  const outboxRow = async (status: string, failure: string | null = "planted_column_mismatch", projectId = scope.projectId) => {
    const id = randomUUID();
    await db().query(
      `INSERT INTO outbox (id, project_id, entity_type, entity_id, source_version, status, attempts, failure_code) VALUES ($1, $2, 'checkout', $3, 1, $4, 8, $5)`,
      [id, projectId, randomUUID(), status, failure],
    );
    return id;
  };
  const proposeDelivery = (targetId: string) => proposeRepair(scope, { kind: "retry_delivery", targetId, reason: "refused", proposedBy: "inv" });

  beforeAll(async () => {
    scope = { projectId: (await one<{ id: string }>("SELECT id FROM project ORDER BY created_at LIMIT 1")).id, environment: "sandbox" };
    const other = randomUUID();
    await db().query("INSERT INTO project (id, name) VALUES ($1, 'inv-other')", [other]);
    otherScope = { projectId: other, environment: "sandbox" };
    const userId = (await one<{ id: string }>('SELECT id FROM "user" LIMIT 1')).id;
    apiKeyId = randomUUID();
    customerId = randomUUID();
    await db().query(`INSERT INTO api_key (id, project_id, environment, name, key_hash, last_four, created_by) VALUES ($1, $2, 'sandbox', 'inv-rep', $3, 'xxxx', $4)`, [apiKeyId, scope.projectId, randomUUID(), userId]);
    await db().query(`INSERT INTO customer (id, project_id, external_customer_id) VALUES ($1, $2, $3)`, [customerId, scope.projectId, `inv-rep-${customerId}`]);
    connectionId = randomUUID();
    await db().query(`INSERT INTO paypal_connection (id, project_id, environment, client_id, secret_encrypted) VALUES ($1, $2, 'sandbox', 'inv', 'inv') ON CONFLICT (project_id, environment) DO NOTHING`, [connectionId, scope.projectId]);
    connectionId = (await one<{ id: string }>(`SELECT id FROM paypal_connection WHERE project_id = $1 AND environment = 'sandbox'`, [scope.projectId])).id;
  });

  afterAll(async () => {
    await closePools();
  });

  it("a failed delivery: proposed, refused to run before approval, run once after, and a second run is refused", async () => {
    const target = await outboxRow("failed");
    const repair = (await proposeDelivery(target))!;
    expect(repair.status).toBe("proposed");
    expect(await executeRepair(scope, repair.id, "inv", noRecheck)).toEqual({ status: "not_approved" });
    expect((await approveRepair(scope, repair.id, "inv"))!.status).toBe("approved");
    expect(await executeRepair(scope, repair.id, "inv", noRecheck)).toEqual({ status: "executed", outcome: "delivery_queued" });
    expect(await one("SELECT status, attempts, failure_code FROM outbox WHERE id = $1", [target])).toEqual({ status: "pending", attempts: 0, failure_code: null });
    expect((await executeRepair(scope, repair.id, "inv", noRecheck)).status).toBe("stale");
  });

  it("five runs at once: one runs, the rest are refused", async () => {
    const repair = (await proposeDelivery(await outboxRow("failed")))!;
    await approveRepair(scope, repair.id, "inv");
    const results = await Promise.all(Array.from({ length: 5 }, () => executeRepair(scope, repair.id, "inv", noRecheck)));
    expect(results.filter((result) => result.status === "executed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "stale")).toHaveLength(4);
  });

  it("a proposal whose record changed since is stale and never runs", async () => {
    const target = await outboxRow("failed");
    const repair = (await proposeDelivery(target))!;
    await approveRepair(scope, repair.id, "inv");
    // Someone retried it by hand in the meantime.
    expect(await retryByHand(scope, "retry_delivery", target)).toBe("retried");
    expect((await executeRepair(scope, repair.id, "inv", noRecheck)).status).toBe("stale");
    expect((await one<{ status: string; outcome: string }>("SELECT status, outcome FROM repair_action WHERE id = $1", [repair.id]))).toEqual({ status: "refused", outcome: "stale" });
  });

  it("a sync retry still runs if the database recovered meanwhile, but only once", async () => {
    await db().query("INSERT INTO sync_status (id, state, code) VALUES (1, 'not_ready', 'permission_denied') ON CONFLICT (id) DO UPDATE SET state = 'not_ready', code = 'permission_denied'");
    const repair = (await proposeRepair(scope, { kind: "retry_sync", targetId: null, reason: "x", proposedBy: "inv" }))!;
    await approveRepair(scope, repair.id, "inv");
    await db().query("UPDATE sync_status SET state = 'ok', code = NULL WHERE id = 1");
    const result = await executeRepair(scope, repair.id, "inv", noRecheck);
    expect(result.status).toBe("executed");
    expect((await executeRepair(scope, repair.id, "inv", noRecheck)).status).toBe("stale");
  });

  it("nothing is proposed for a delivered row, another project's row, or an unknown one", async () => {
    expect(await proposeDelivery(await outboxRow("delivered", null))).toBeNull();
    expect(await proposeDelivery(await outboxRow("failed", "x", otherScope.projectId))).toBeNull();
    expect(await proposeDelivery(randomUUID())).toBeNull();
  });

  it("a paid, settled purchase gets no payment action; only an unknown outcome does", async () => {
    const paid = await checkout({ money: "captured", order: `ORD-${randomUUID()}` });
    expect(await proposeRepair(scope, { kind: "recheck_payment", targetId: paid, reason: "x", proposedBy: "inv" })).toBeNull();
    const unclear = await checkout({ money: "unresolved", order: `ORD-${randomUUID()}` });
    await db().query("UPDATE checkout SET money_reason = 'capture_outcome_unknown' WHERE id = $1", [unclear]);
    expect(await proposeRepair(scope, { kind: "recheck_payment", targetId: unclear, reason: "x", proposedBy: "inv" })).not.toBeNull();
    const mismatch = await checkout({ money: "unresolved", order: `ORD-${randomUUID()}` });
    await db().query("UPDATE checkout SET money_reason = 'amount_mismatch' WHERE id = $1", [mismatch]);
    expect(await proposeRepair(scope, { kind: "recheck_payment", targetId: mismatch, reason: "x", proposedBy: "inv" })).toBeNull();
  });

  it("a failed event can be retried; a processed one can't", async () => {
    const failed = randomUUID();
    const processed = randomUUID();
    for (const [id, status] of [[failed, "failed"], [processed, "processed"]] as const) {
      await db().query(`INSERT INTO paypal_event (id, connection_id, event_id, event_type, payload, status, attempts) VALUES ($1, $2, $3, 'X', '{}', $4, 8)`, [id, connectionId, `WH-${id}`, status]);
    }
    expect(await proposeRepair(scope, { kind: "retry_event", targetId: processed, reason: "x", proposedBy: "inv" })).toBeNull();
    expect(await retryByHand(scope, "retry_event", processed)).toBe("not_retryable");
    expect(await retryByHand(scope, "retry_event", failed)).toBe("retried");
    expect((await one<{ status: string }>("SELECT status FROM paypal_event WHERE id = $1", [failed])).status).toBe("pending");
  });

  it("resend everything puts each record's latest change back in line, once per record", async () => {
    const entity = randomUUID();
    for (const version of [1, 2, 3]) {
      await db().query(`INSERT INTO outbox (id, project_id, entity_type, entity_id, source_version, status, delivered_at) VALUES ($1, $2, 'checkout', $3, $4, 'delivered', now())`, [randomUUID(), scope.projectId, entity, version]);
    }
    await resendEverything(scope);
    const { rows } = await db().query("SELECT source_version, status FROM outbox WHERE entity_id = $1 ORDER BY source_version", [entity]);
    expect(rows).toEqual([
      { source_version: 1, status: "delivered" },
      { source_version: 2, status: "delivered" },
      { source_version: 3, status: "pending" },
    ]);
  });

  it("reconciliation picks up an order with no event after a few minutes, and never one past its hour", async () => {
    await db().query("UPDATE checkout SET next_check_at = now() + interval '1 day' WHERE next_check_at IS NULL OR next_check_at <= now()");
    const due = await checkout({ order: `ORD-${randomUUID()}`, ago: "10 minutes" });
    await checkout({ order: `ORD-${randomUUID()}`, ago: "1 minute" });
    await checkout({ order: `ORD-${randomUUID()}`, ago: "70 minutes", expiresIn: "-10 minutes" });
    const claimed = await Promise.all(Array.from({ length: 5 }, () => claimUnconfirmedOrder()));
    expect(claimed.filter((id) => id !== null)).toEqual([due]);
  });
});
