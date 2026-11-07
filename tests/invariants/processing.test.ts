// Billing invariants against real Postgres, with no PayPal. Writes rows and adds triggers, so it only runs on a throwaway
// database, with no worker running: a worker would take these rows for itself.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyCheckoutBenefits,
  claimCheckoutForBenefits,
  claimPaypalEvent,
  claimUnclearCheckout,
  closePools,
  failAbandonedPaypalEvents,
  findCheckout,
  finishPaypalEvent,
  markCaptureRequested,
  recordCheckoutMoney,
  restrictRefundedCheckout,
  retryPaypalEvent,
  storePaypalEvent,
} from "../../packages/db/src/index";
import { getSourcePool } from "../../packages/db/src/client";

const db = () => getSourcePool();
const one = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) => (await db().query(text, values)).rows[0] as T;
const count = async (text: string, values: unknown[] = []) => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM ${text}`, values)).n);

const CAPTURED = { moneyStatus: "captured", moneyReason: null } as const;
const ACCESS = [{ kind: "access", key: "pro" }];
const CREDITS = [{ kind: "credits", amount: 100 }];

describe.runIf(process.env.E2E_WRITE_DB === "1")("processing invariants", { timeout: 60_000 }, () => {
  let projectId: string;
  let apiKeyId: string;
  let customerId: string;
  let connectionId: string;
  let serial = 0;

  const newCheckout = async (benefits: unknown[] = [], extra: { environment?: string; customer?: string } = {}) => {
    serial += 1;
    const id = randomUUID();
    const snapshot = { source: "merchant", catalogVersion: null, product: { ref: "p", name: "P", kind: "one_time" }, variant: null, quantity: 1, unitAmount: 100, amount: 100, currency: "USD", benefits, metadata: {} };
    await db().query(
      `INSERT INTO checkout (id, project_id, environment, customer_id, api_key_id, idempotency_key, payload_hash, return_url, snapshot, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'x', 'https://a.example/r', $7, now() + interval '1 hour')`,
      [id, projectId, extra.environment ?? "sandbox", extra.customer ?? customerId, apiKeyId, `inv-${serial}-${id}`, JSON.stringify(snapshot)],
    );
    return id;
  };
  const capture = (id: string, captureId = `CAP-${id}`) =>
    recordCheckoutMoney(id, { ...CAPTURED, capture: { id: captureId, amount: 100, currency: "USD" } });
  const paidCheckout = async (benefits: unknown[] = ACCESS) => {
    const id = await newCheckout(benefits);
    await capture(id);
    return id;
  };
  const outboxRows = (type: string, id: string) => count("outbox WHERE entity_type = $1 AND entity_id = $2", [type, id]);
  const checkoutRow = (id: string) => one<{ money_status: string; fulfillment_status: string; fulfillment_reason: string | null; source_version: number; next_check_at: Date | null; check_attempts: number }>("SELECT * FROM checkout WHERE id = $1", [id]);

  const breakInsertsInto = async (table: string) => {
    await db().query(`
      CREATE OR REPLACE FUNCTION inv_refuse() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS inv_refuse ON ${table};
      CREATE TRIGGER inv_refuse BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION inv_refuse();`);
  };
  const repairInsertsInto = (table: string) => db().query(`DROP TRIGGER IF EXISTS inv_refuse ON ${table}`);

  beforeAll(async () => {
    projectId = (await one<{ id: string }>("SELECT id FROM project LIMIT 1")).id;
    const userId = (await one<{ id: string }>('SELECT id FROM "user" LIMIT 1')).id;
    apiKeyId = randomUUID();
    customerId = randomUUID();
    connectionId = randomUUID();
    await db().query(`INSERT INTO api_key (id, project_id, environment, name, key_hash, last_four, created_by) VALUES ($1, $2, 'sandbox', 'inv', $3, 'xxxx', $4)`, [apiKeyId, projectId, randomUUID(), userId]);
    await db().query(`INSERT INTO customer (id, project_id, external_customer_id) VALUES ($1, $2, $3)`, [customerId, projectId, `inv-${customerId}`]);
    await db().query(`INSERT INTO paypal_connection (id, project_id, environment, client_id, secret_encrypted) VALUES ($1, $2, 'sandbox', 'inv', 'inv') ON CONFLICT (project_id, environment) DO NOTHING`, [connectionId, projectId]);
    connectionId = (await one<{ id: string }>(`SELECT id FROM paypal_connection WHERE project_id = $1 AND environment = 'sandbox'`, [projectId])).id;
  });

  afterAll(async () => {
    await closePools();
  });

  describe("money changes and their outbox rows", () => {
    it("a change writes one row, with the new version", async () => {
      const id = await newCheckout();
      await capture(id);
      expect(await checkoutRow(id)).toMatchObject({ money_status: "captured", source_version: 1 });
      expect(await outboxRows("checkout", id)).toBe(1);
    });

    it("20 identical confirms at once make one row", async () => {
      const id = await newCheckout();
      await Promise.all(Array.from({ length: 20 }, () => capture(id)));
      expect(await checkoutRow(id)).toMatchObject({ source_version: 1 });
      expect(await outboxRows("checkout", id)).toBe(1);
    });

    it("repeating what's stored writes nothing, even while it can still change", async () => {
      const id = await newCheckout();
      await recordCheckoutMoney(id, { moneyStatus: "unresolved", moneyReason: "capture_outcome_unknown" });
      await recordCheckoutMoney(id, { moneyStatus: "unresolved", moneyReason: "capture_outcome_unknown" });
      expect(await checkoutRow(id)).toMatchObject({ source_version: 1 });
      expect(await outboxRows("checkout", id)).toBe(1);
    });

    it("nothing moves a captured checkout backward", async () => {
      const id = await paidCheckout([]);
      for (const moneyStatus of ["failed", "approved", "unresolved"] as const) await recordCheckoutMoney(id, { moneyStatus, moneyReason: null });
      expect(await checkoutRow(id)).toMatchObject({ money_status: "captured", source_version: 1 });
    });

    it("a refused outbox row undoes the money change", async () => {
      const id = await newCheckout();
      await breakInsertsInto("outbox");
      try {
        await expect(capture(id)).rejects.toThrow();
      } finally {
        await repairInsertsInto("outbox");
      }
      expect(await checkoutRow(id)).toMatchObject({ money_status: "pending", source_version: 0 });
      expect(await outboxRows("checkout", id)).toBe(0);
    });
  });

  describe("benefits", () => {
    it("20 at once: one effect, one grant, applied once", async () => {
      const id = await paidCheckout();
      await Promise.all(Array.from({ length: 20 }, () => applyCheckoutBenefits(id)));
      expect(await count("billing_effect WHERE checkout_id = $1", [id])).toBe(1);
      expect(await count("access_grant WHERE checkout_id = $1", [id])).toBe(1);
      expect(await checkoutRow(id)).toMatchObject({ fulfillment_status: "applied", source_version: 2 });
      expect(await outboxRows("checkout", id)).toBe(2);
      const grant = await one<{ id: string; status: string; source_version: number; access_key: string }>("SELECT * FROM access_grant WHERE checkout_id = $1", [id]);
      expect(grant).toMatchObject({ status: "active", source_version: 1, access_key: "pro" });
      expect(await outboxRows("access_grant", grant.id)).toBe(1);
    });

    it("a plain purchase has nothing to apply, and is applied", async () => {
      const id = await paidCheckout([]);
      await applyCheckoutBenefits(id);
      expect(await checkoutRow(id)).toMatchObject({ fulfillment_status: "applied" });
      expect(await count("billing_effect WHERE checkout_id = $1", [id])).toBe(0);
    });

    it("credits stay pending, named, and the scan leaves them alone", async () => {
      const id = await paidCheckout(CREDITS);
      await applyCheckoutBenefits(id);
      expect(await checkoutRow(id)).toMatchObject({ fulfillment_status: "pending", fulfillment_reason: "waiting_for_credit_ledger", source_version: 1 });
      while (await claimCheckoutForBenefits()) {
        // Drains others from earlier tests.
      }
      await db().query("UPDATE checkout SET next_check_at = NULL WHERE id = $1", [id]);
      expect(await claimCheckoutForBenefits()).toBeNull();
    });

    it("no benefits before the money is captured", async () => {
      const id = await newCheckout(ACCESS);
      await applyCheckoutBenefits(id);
      expect(await checkoutRow(id)).toMatchObject({ fulfillment_status: "pending" });
      expect(await count("access_grant WHERE checkout_id = $1", [id])).toBe(0);
    });

    it("a capture already used for an effect grants nothing again", async () => {
      const id = await paidCheckout();
      await db().query("INSERT INTO billing_effect (id, project_id, checkout_id, paypal_payment_id, kind) VALUES ($1, $2, $3, $4, 'access')", [randomUUID(), projectId, id, `CAP-${id}`]);
      await applyCheckoutBenefits(id);
      expect(await count("access_grant WHERE checkout_id = $1", [id])).toBe(0);
    });

    it.each(["billing_effect", "access_grant", "outbox"])("a refused %s row undoes the whole step", async (table) => {
      const id = await paidCheckout();
      await breakInsertsInto(table);
      try {
        await expect(applyCheckoutBenefits(id)).rejects.toThrow();
      } finally {
        await repairInsertsInto(table);
      }
      expect(await checkoutRow(id)).toMatchObject({ money_status: "captured", fulfillment_status: "pending", source_version: 1 });
      expect(await count("billing_effect WHERE checkout_id = $1", [id])).toBe(0);
      expect(await count("access_grant WHERE checkout_id = $1", [id])).toBe(0);
      await applyCheckoutBenefits(id);
      expect(await checkoutRow(id)).toMatchObject({ fulfillment_status: "applied" });
    });
  });

  describe("refunds", () => {
    const captureOf = (id: string) => `CAP-${id}`;

    it("moves money to review and restricts access, in one go", async () => {
      const id = await paidCheckout();
      await applyCheckoutBenefits(id);
      expect(await restrictRefundedCheckout(id, captureOf(id))).toBe(true);
      expect(await checkoutRow(id)).toMatchObject({ money_status: "refund_review", fulfillment_status: "restricted", source_version: 3 });
      const grant = await one<{ id: string; status: string; source_version: number }>("SELECT * FROM access_grant WHERE checkout_id = $1", [id]);
      expect(grant).toMatchObject({ status: "restricted", source_version: 2 });
      expect(await outboxRows("access_grant", grant.id)).toBe(2);
      expect(await outboxRows("checkout", id)).toBe(3);
    });

    it("only the exact capture, only once", async () => {
      const id = await paidCheckout();
      expect(await restrictRefundedCheckout(id, "SOMEONE-ELSES")).toBe(false);
      expect(await checkoutRow(id)).toMatchObject({ money_status: "captured" });
      expect(await restrictRefundedCheckout(id, captureOf(id))).toBe(true);
      expect(await restrictRefundedCheckout(id, captureOf(id))).toBe(false);
      expect(await checkoutRow(id)).toMatchObject({ source_version: 2 });
    });

    it("a refund before benefits means no benefits, ever", async () => {
      const id = await paidCheckout();
      await restrictRefundedCheckout(id, captureOf(id));
      await applyCheckoutBenefits(id);
      expect(await count("access_grant WHERE checkout_id = $1", [id])).toBe(0);
      expect(await checkoutRow(id)).toMatchObject({ fulfillment_status: "restricted" });
    });

    it("another purchase's grant stays active", async () => {
      const customer = randomUUID();
      await db().query(`INSERT INTO customer (id, project_id, external_customer_id) VALUES ($1, $2, $3)`, [customer, projectId, `inv-${customer}`]);
      const [kept, refunded] = [await newCheckout(ACCESS, { customer }), await newCheckout(ACCESS, { customer })];
      for (const id of [kept, refunded]) {
        await capture(id);
        await applyCheckoutBenefits(id);
      }
      await restrictRefundedCheckout(refunded, captureOf(refunded));
      expect(await count("access_grant WHERE customer_id = $1 AND status = 'active' AND checkout_id = $2", [customer, kept])).toBe(1);
      expect(await count("access_grant WHERE customer_id = $1 AND status = 'restricted' AND checkout_id = $2", [customer, refunded])).toBe(1);
    });

    it("racing benefits, however it lands, never leaves access active after a refund", async () => {
      for (let round = 0; round < 15; round += 1) {
        const id = await paidCheckout();
        await Promise.all([applyCheckoutBenefits(id), restrictRefundedCheckout(id, captureOf(id)), applyCheckoutBenefits(id)]);
        expect(await checkoutRow(id)).toMatchObject({ money_status: "refund_review", fulfillment_status: "restricted" });
        expect(await count("access_grant WHERE checkout_id = $1 AND status = 'active'", [id])).toBe(0);
      }
    });

    it("a refused outbox row undoes the refund move", async () => {
      const id = await paidCheckout();
      await applyCheckoutBenefits(id);
      await breakInsertsInto("outbox");
      try {
        await expect(restrictRefundedCheckout(id, captureOf(id))).rejects.toThrow();
      } finally {
        await repairInsertsInto("outbox");
      }
      expect(await checkoutRow(id)).toMatchObject({ money_status: "captured", fulfillment_status: "applied" });
      expect(await count("access_grant WHERE checkout_id = $1 AND status = 'active'", [id])).toBe(1);
    });
  });

  describe("claiming events", () => {
    const newEvent = async (eventType = "PAYMENT.CAPTURE.COMPLETED") => {
      const eventId = `WH-${randomUUID()}`;
      await storePaypalEvent({ connectionId, eventId, eventType, rawBody: JSON.stringify({ id: eventId }) });
      return (await one<{ id: string }>("SELECT id FROM paypal_event WHERE event_id = $1", [eventId])).id;
    };
    const eventRow = (id: string) => one<{ status: string; attempts: number; failure_code: string | null; wait: number; processed_at: Date | null }>("SELECT *, extract(epoch FROM next_attempt_at - now())::float8 AS wait FROM paypal_event WHERE id = $1", [id]);
    const clearEvents = () => db().query("UPDATE paypal_event SET status = 'ignored' WHERE status = 'pending'");

    beforeEach(clearEvents);

    it("the same event stored twice is one row", async () => {
      const eventId = `WH-${randomUUID()}`;
      for (let time = 0; time < 2; time += 1) await storePaypalEvent({ connectionId, eventId, eventType: "X", rawBody: "{}" });
      expect(await count("paypal_event WHERE event_id = $1", [eventId])).toBe(1);
    });

    it("20 claims at once take each event once", async () => {
      const ids = await Promise.all(Array.from({ length: 5 }, () => newEvent()));
      const claimed = (await Promise.all(Array.from({ length: 20 }, () => claimPaypalEvent()))).filter((event) => event !== null);
      expect(claimed.map((event) => event.id).sort()).toEqual([...ids].sort());
    });

    it("a claimed event is hidden for the lease, then comes back by itself", async () => {
      const id = await newEvent();
      expect((await claimPaypalEvent())?.id).toBe(id);
      expect(await claimPaypalEvent()).toBeNull();
      expect((await eventRow(id)).wait).toBeGreaterThan(100);
      await db().query("UPDATE paypal_event SET next_attempt_at = now() WHERE id = $1", [id]);
      expect((await claimPaypalEvent())?.id).toBe(id);
      expect(await eventRow(id)).toMatchObject({ attempts: 2 });
    });

    it("a claim carries the project of the webhook that received it", async () => {
      await newEvent();
      expect((await claimPaypalEvent())?.scope).toEqual({ projectId, environment: "sandbox" });
    });

    it("waits longer each time: 5s, 30s, 2m, 10m, 1h, then fails on the 8th", async () => {
      const id = await newEvent();
      const waits = [5, 30, 120, 600, 3600, 3600, 3600];
      for (const expectedWait of waits) {
        await db().query("UPDATE paypal_event SET next_attempt_at = now() WHERE id = $1", [id]);
        expect((await claimPaypalEvent())?.id).toBe(id);
        await retryPaypalEvent(id, "paypal_unavailable");
        const row = await eventRow(id);
        expect(row.status).toBe("pending");
        expect(row.wait).toBeGreaterThan(expectedWait - 2);
        expect(row.wait).toBeLessThanOrEqual(expectedWait);
      }
      await db().query("UPDATE paypal_event SET next_attempt_at = now() WHERE id = $1", [id]);
      expect((await claimPaypalEvent())?.id).toBe(id);
      await retryPaypalEvent(id, "paypal_unavailable");
      expect(await eventRow(id)).toMatchObject({ status: "failed", attempts: 8, failure_code: "paypal_unavailable" });
      await db().query("UPDATE paypal_event SET next_attempt_at = now() WHERE id = $1", [id]);
      expect(await claimPaypalEvent()).toBeNull();
    });

    it("a bad event doesn't hold up others", async () => {
      const bad = await newEvent();
      expect((await claimPaypalEvent())?.id).toBe(bad);
      await retryPaypalEvent(bad, "internal_error");
      const good = await newEvent();
      expect((await claimPaypalEvent())?.id).toBe(good);
    });

    it("a worker that died on the last attempt doesn't leave it pending forever", async () => {
      const id = await newEvent();
      await db().query("UPDATE paypal_event SET attempts = 8, next_attempt_at = now() WHERE id = $1", [id]);
      await failAbandonedPaypalEvents();
      expect(await eventRow(id)).toMatchObject({ status: "failed", failure_code: "worker_died" });
    });

    it("finishing records it, and a late retry can't reopen it", async () => {
      const id = await newEvent();
      await claimPaypalEvent();
      await finishPaypalEvent(id, "processed");
      await retryPaypalEvent(id, "paypal_unavailable");
      const row = await eventRow(id);
      expect(row).toMatchObject({ status: "processed", failure_code: null });
      expect(row.processed_at).not.toBeNull();
    });
  });

  describe("scans", () => {
    const drain = async (claim: () => Promise<string | null>) => {
      const seen: string[] = [];
      for (let id = await claim(); id; id = await claim()) seen.push(id);
      return seen;
    };

    it("benefits: finds a capture with no benefits applied, once per wait", async () => {
      await drain(claimCheckoutForBenefits);
      const id = await paidCheckout();
      expect(await drain(claimCheckoutForBenefits)).toEqual([id]);
      expect(await checkoutRow(id)).toMatchObject({ check_attempts: 1 });
      expect(await drain(claimCheckoutForBenefits)).toEqual([]);
    });

    it("benefits: 20 claims at once take it once", async () => {
      await drain(claimCheckoutForBenefits);
      const id = await paidCheckout();
      const claimed = (await Promise.all(Array.from({ length: 20 }, () => claimCheckoutForBenefits()))).filter(Boolean);
      expect(claimed).toEqual([id]);
    });

    it("benefits: applied, refunded and unpaid checkouts aren't found", async () => {
      const applied = await paidCheckout();
      await applyCheckoutBenefits(applied);
      const refunded = await paidCheckout();
      await restrictRefundedCheckout(refunded, `CAP-${refunded}`);
      await newCheckout(ACCESS);
      expect(await drain(claimCheckoutForBenefits)).toEqual([]);
    });

    it("a planted live checkout is never touched", async () => {
      const id = await newCheckout(ACCESS, { environment: "live" });
      await capture(id);
      expect(await drain(claimCheckoutForBenefits)).not.toContain(id);
      const unclear = await newCheckout([], { environment: "live" });
      await db().query("UPDATE checkout SET paypal_order_id = $2 WHERE id = $1", [unclear, `ORDER-${unclear}`]);
      await recordCheckoutMoney(unclear, { moneyStatus: "unresolved", moneyReason: "capture_outcome_unknown" });
      expect(await drain(claimUnclearCheckout)).not.toContain(unclear);
    });

    const unclearCheckout = async () => {
      const id = await newCheckout();
      await db().query("UPDATE checkout SET paypal_order_id = $2 WHERE id = $1", [id, `ORDER-${id}`]);
      await recordCheckoutMoney(id, { moneyStatus: "unresolved", moneyReason: "capture_outcome_unknown" });
      return id;
    };

    it("unclear: finds an unknown outcome, and waits longer each time", async () => {
      await drain(claimUnclearCheckout);
      const id = await unclearCheckout();
      for (const expectedWait of [5, 30, 120, 600, 3600]) {
        expect(await drain(claimUnclearCheckout)).toEqual([id]);
        const { wait } = await one<{ wait: number }>("SELECT extract(epoch FROM next_check_at - now())::float8 AS wait FROM checkout WHERE id = $1", [id]);
        expect(wait).toBeGreaterThan(expectedWait - 2);
        expect(wait).toBeLessThanOrEqual(expectedWait);
        await db().query("UPDATE checkout SET next_check_at = now() WHERE id = $1", [id]);
      }
    });

    it("unclear: gives up after about a day and stays unresolved", async () => {
      await drain(claimUnclearCheckout);
      const id = await unclearCheckout();
      await db().query("UPDATE checkout SET check_attempts = 28 WHERE id = $1", [id]);
      expect(await drain(claimUnclearCheckout)).toEqual([]);
      expect((await findCheckout(id))?.moneyStatus).toBe("unresolved");
    });

    it("unclear: a capture just sent waits, so it isn't repeated while on its way", async () => {
      await drain(claimUnclearCheckout);
      const id = await newCheckout();
      await db().query("UPDATE checkout SET paypal_order_id = $2 WHERE id = $1", [id, `ORDER-${id}`]);
      await recordCheckoutMoney(id, { moneyStatus: "approved", moneyReason: null });
      await markCaptureRequested(id);
      expect(await drain(claimUnclearCheckout)).toEqual([]);
      await db().query("UPDATE checkout SET next_check_at = now() WHERE id = $1", [id]);
      expect(await drain(claimUnclearCheckout)).toEqual([id]);
    });

    it("unclear: approved with no capture sent isn't found, and a mismatch is left for a person", async () => {
      await drain(claimUnclearCheckout);
      const approved = await newCheckout();
      await db().query("UPDATE checkout SET paypal_order_id = $2 WHERE id = $1", [approved, `ORDER-${approved}`]);
      await recordCheckoutMoney(approved, { moneyStatus: "approved", moneyReason: null });
      const mismatched = await newCheckout();
      await db().query("UPDATE checkout SET paypal_order_id = $2 WHERE id = $1", [mismatched, `ORDER-${mismatched}`]);
      await recordCheckoutMoney(mismatched, { moneyStatus: "unresolved", moneyReason: "amount_mismatch" });
      expect(await drain(claimUnclearCheckout)).toEqual([]);
    });

    it("once the money changes, its benefits don't wait for the old backoff", async () => {
      await drain(claimUnclearCheckout);
      await drain(claimCheckoutForBenefits);
      const id = await unclearCheckout();
      await db().query("UPDATE checkout SET next_check_at = now() + interval '1 hour', check_attempts = 10 WHERE id = $1", [id]);
      await capture(id);
      expect(await checkoutRow(id)).toMatchObject({ next_check_at: null, check_attempts: 0 });
      expect(await drain(claimCheckoutForBenefits)).toEqual([id]);
    });
  });
});
