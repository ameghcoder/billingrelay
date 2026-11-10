// Runs against a live stack (see README), through HTTP like a real caller. The E2E_WRITE_DB block creates an API key and plants a
// paid credit pack straight into the source database (labelled `planted`: a real one needs PayPal), so only on a throwaway database.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const RATE_LIMIT_WINDOW_MS = 11_000;

describe("credits without a key", () => {
  it.each([
    ["POST", "/v1/credits/consume"],
    ["POST", "/v1/usage/job-1/compensate"],
    ["GET", "/v1/customers/anyone/billing"],
  ])("%s %s returns 401", async (method, path) => {
    const res = await fetch(`${BASE_URL}${path}`, { method });
    expect(res.status).toBe(401);
  });
});

describe.runIf(process.env.E2E_WRITE_DB === "1")("credits with a key", { timeout: 60_000 }, () => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const buyer = `planted-credits-${Date.now().toString(36)}`;
  let apiKey: string;

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const consume = (amount: number, usageId: string, externalCustomerId = buyer) => call("POST", "/v1/credits/consume", { externalCustomerId, amount, usageId });

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
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.includes("session_token"))!;
    const created = await fetch(`${BASE_URL}/admin/developers/api-keys`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: BASE_URL, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e credits" }),
    });
    apiKey = (await created.json()).key;

    // Planted: a captured pack checkout, then its benefits applied the way the worker does, through the real code.
    const project = (await db.query("SELECT id FROM project ORDER BY created_at LIMIT 1")).rows[0].id;
    const apiKeyId = (await db.query("SELECT id FROM api_key WHERE last_four = $1 ORDER BY created_at DESC LIMIT 1", [apiKey.slice(-4)])).rows[0].id;
    const customerId = randomUUID();
    await db.query("INSERT INTO customer (id, project_id, external_customer_id) VALUES ($1, $2, $3)", [customerId, project, buyer]);
    const snapshot = {
      source: "catalog", catalogVersion: 1, product: { ref: "planted-pack", name: "Pack", kind: "credit_pack" }, variant: { ref: "v", name: "V", attributes: {} },
      quantity: 1, unitAmount: 500, amount: 500, currency: "USD", benefits: [{ kind: "credits", amount: 100 }], metadata: {},
    };
    const checkoutId = randomUUID();
    await db.query(
      `INSERT INTO checkout (id, project_id, environment, customer_id, api_key_id, idempotency_key, payload_hash, return_url, snapshot, expires_at,
                             money_status, paypal_capture_id, captured_amount, captured_currency, source_version)
       VALUES ($1, $2, 'sandbox', $3, $4, $5, 'planted', 'https://a.example/r', $6, now() + interval '1 hour', 'captured', $7, 500, 'USD', 1)`,
      [checkoutId, project, customerId, apiKeyId, `planted-${checkoutId}`, JSON.stringify(snapshot), `PLANTED-CAP-${checkoutId}`],
    );
    const { applyCheckoutBenefits } = await import("../../packages/db/src/index");
    await applyCheckoutBenefits(checkoutId);
  });

  afterAll(async () => {
    await db.end();
    const { closePools } = await import("../../packages/db/src/index");
    await closePools();
  });

  it("spends, and a retry gets the same answer without a second debit", async () => {
    const first = await consume(30, "e2e-job-1");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ usageId: "e2e-job-1", debited: 30, balance: { packs: 70, monthly: 0, total: 70 } });
    const again = await consume(30, "e2e-job-1");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ debited: 30, balance: { total: 70 } });
  });

  it("refuses more than the balance, and stores nothing", async () => {
    const res = await consume(71, "e2e-too-much");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "insufficient_credits", details: { balance: { total: 70 } } } });
    // The same usageId still works once there's enough, which only holds if nothing was stored.
    expect((await consume(70, "e2e-too-much")).status).toBe(200);
  });

  it("a usageId reused for another amount is a conflict", async () => {
    const res = await consume(5, "e2e-job-1");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("usage_conflict");
  });

  it("gives a failed usage back once", async () => {
    const first = await call("POST", "/v1/usage/e2e-too-much/compensate");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ usageId: "e2e-too-much", compensated: 70, balance: { total: 70 } });
    const again = await call("POST", "/v1/usage/e2e-too-much/compensate");
    expect(await again.json()).toMatchObject({ compensated: 70, balance: { total: 70 } });
    expect((await call("POST", "/v1/usage/never-used/compensate")).status).toBe(404);
  });

  it.each([
    [{ externalCustomerId: "x", amount: 0, usageId: "a" }],
    [{ externalCustomerId: "x", amount: 1.5, usageId: "a" }],
    [{ externalCustomerId: "x", amount: 1, usageId: "has space" }],
    [{ externalCustomerId: "x", amount: 1 }],
  ])("refuses %j with 400", async (body) => {
    expect((await call("POST", "/v1/credits/consume", body)).status).toBe(400);
  });

  it("the billing read shows the credits and the paid pack, and 404s a stranger", async () => {
    const res = await call("GET", `/v1/customers/${encodeURIComponent(buyer)}/billing`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ externalCustomerId: buyer, credits: { packs: 70, monthly: 0, total: 70, monthlyEndsAt: null }, subscriptions: [], access: [] });
    expect(body.purchases).toEqual([expect.objectContaining({ productKind: "credit_pack", money: "captured", fulfillment: "applied" })]);
    expect(body.version).toBeGreaterThan(0);
    expect((await call("GET", `/v1/customers/stranger-${Date.now()}/billing`)).status).toBe(404);
  });
});
