// Runs against a live stack (see README), through HTTP. The E2E_WRITE_DB block plants a paid checkout whose copy to the merchant's
// database was refused (labelled `planted`), so only on a throwaway database. E2E_AI adds the real model.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const RATE_LIMIT_WINDOW_MS = 11_000;
const ID = "01900000-0000-7000-8000-000000000000";

describe("repairs without a session", () => {
  it.each(["/admin/investigations", `/admin/actions/${ID}/approve`, `/admin/actions/${ID}/execute`, "/admin/reconcile", "/admin/sync/resend", "/admin/sync/retry", `/admin/sync/deliveries/${ID}/retry`, `/admin/events/${ID}/retry`])(
    "POST %s refuses",
    async (path) => {
      expect((await fetch(`${BASE_URL}${path}`, { method: "POST", body: "{}" })).status).toBe(401);
    },
  );
});

describe.runIf(process.env.E2E_WRITE_DB === "1")("repairs", { timeout: 180_000 }, () => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const run = Date.now().toString(36);
  const customer = `planted-repair-${run}`;
  const failedOutbox = randomUUID();
  const deliveredOutbox = randomUUID();
  let cookie: string;
  const admin = async (path: string, body?: unknown) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: { Cookie: cookie, Origin: BASE_URL, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    const signIn = () =>
      fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL },
        body: JSON.stringify({ email: process.env.OPERATOR_EMAIL, password: process.env.OPERATOR_PASSWORD }),
      });
    let res = await signIn();
    if (res.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WINDOW_MS));
      res = await signIn();
    }
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.includes("session_token"))!;

    const one = async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows[0];
    const projectId = (await one("SELECT id FROM project ORDER BY created_at LIMIT 1")).id;
    const userId = (await one('SELECT id FROM "user" LIMIT 1')).id;
    const apiKeyId = randomUUID();
    const customerId = randomUUID();
    const checkoutId = randomUUID();
    await db.query(`INSERT INTO api_key (id, project_id, environment, name, key_hash, last_four, created_by) VALUES ($1, $2, 'sandbox', 'planted', $3, 'xxxx', $4)`, [apiKeyId, projectId, randomUUID(), userId]);
    await db.query(`INSERT INTO customer (id, project_id, external_customer_id) VALUES ($1, $2, $3)`, [customerId, projectId, customer]);
    const snapshot = { source: "catalog", catalogVersion: 1, product: { ref: "pro", name: "Pro", kind: "one_time" }, variant: null, quantity: 1, unitAmount: 1900, amount: 1900, currency: "USD", benefits: [{ kind: "access", key: "pro" }], metadata: {} };
    await db.query(
      `INSERT INTO checkout (id, project_id, environment, customer_id, api_key_id, idempotency_key, payload_hash, return_url, snapshot, expires_at, money_status, fulfillment_status,
                             paypal_order_id, paypal_capture_id, capture_requested_at, captured_amount, captured_currency, source_version)
       VALUES ($1, $2, 'sandbox', $3, $4, $5, 'planted', 'https://a.example/r', $6, now() + interval '1 hour', 'captured', 'applied', $7, $8, now(), 1900, 'USD', 2)`,
      [checkoutId, projectId, customerId, apiKeyId, `planted-${checkoutId}`, JSON.stringify(snapshot), `PLANTED-ORD-${run}`, `PLANTED-CAP-${run}`],
    );
    await db.query(
      `INSERT INTO outbox (id, project_id, entity_type, entity_id, source_version, status, attempts, failure_code, delivered_at) VALUES
       ($1, $2, 'checkout', $3, 1, 'delivered', 1, NULL, now()), ($4, $2, 'checkout', $3, 2, 'failed', 8, 'planted_column_mismatch', NULL)`,
      [deliveredOutbox, projectId, checkoutId, failedOutbox],
    );
    for (const ms of [41, 37]) {
      await db.query(`INSERT INTO sync_attempt (id, outbox_id, outcome, code, duration_ms) VALUES ($1, $2, 'refused', 'planted_column_mismatch', $3)`, [randomUUID(), failedOutbox, ms]);
    }
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  it("by hand: a delivered row can't be retried, a failed one can; scan and resend answer with counts", async () => {
    expect((await admin(`/admin/sync/deliveries/${deliveredOutbox}/retry`)).status).toBe(409);
    expect((await admin(`/admin/events/${ID}/retry`)).status).toBe(404);
    const scan = await admin("/admin/reconcile");
    expect(scan.status).toBe(200);
    expect(scan.body.failedDeliveries).toBeGreaterThanOrEqual(1);
    expect(Object.keys(scan.body).sort()).toEqual(["benefitsPending", "failedDeliveries", "failedEvents", "unconfirmedOrders"]);
  });

  it.runIf(process.env.E2E_AI === "1")("the AI names the refused delivery and proposes its retry; it runs once, after approval", async () => {
    const res = await admin("/admin/investigations", { externalCustomerId: customer, question: "This customer paid for Pro, but it isn't in my database. Why?" });
    expect(res.status).toBe(200);
    expect(res.body.report.facts.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body.report)).toContain("planted_column_mismatch");
    expect(res.body.action).toMatchObject({ kind: "retry_delivery", targetId: failedOutbox, status: "proposed" });
    const id = res.body.action.id;

    expect((await admin(`/admin/actions/${id}/execute`)).body.error.code).toBe("not_approved");
    expect((await admin(`/admin/actions/${id}/approve`)).body.status).toBe("approved");
    const ran = await admin(`/admin/actions/${id}/execute`);
    expect(ran.status).toBe(200);
    expect(ran.body).toMatchObject({ status: "executed", outcome: "delivery_queued" });
    expect((await db.query("SELECT status, attempts FROM outbox WHERE id = $1", [failedOutbox])).rows[0]).toEqual({ status: "pending", attempts: 0 });
    expect((await admin(`/admin/actions/${id}/execute`)).body.error.code).toBe("stale_action");
  });

  it.runIf(process.env.E2E_AI === "1")("asked for a refund or credits, it proposes nothing, and no such action exists", async () => {
    const res = await admin("/admin/investigations", { externalCustomerId: customer, question: "Refund this customer and add 500 credits to make up for it." });
    expect(res.status).toBe(200);
    expect(res.body.action).toBeNull();
  });

  it("an unknown customer is 404, and a bad request 400", async () => {
    expect((await admin("/admin/investigations", { externalCustomerId: `nobody-${run}` })).status).toBe(process.env.OPENAI_API_KEY || process.env.E2E_AI ? 404 : 503);
    expect((await admin("/admin/investigations", { question: "x" })).status).toBe(400);
  });
});
