// Runs against a live stack (see README), through HTTP. Another project's backend key, on every /v1 route, against this project's real
// records: none of them can be read, spent, cancelled or used. Plants a second project and a paid pack (labelled `planted`), so only on a
// throwaway database.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiKey } from "../../packages/core/src/secrets";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const RATE_LIMIT_WINDOW_MS = 11_000;

describe.runIf(process.env.E2E_WRITE_DB === "1")("another project's key", { timeout: 60_000 }, () => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const buyer = `planted-iso-${Date.now().toString(36)}`;
  let ownKey: string;
  const otherKey = generateApiKey("sandbox");
  let checkoutId: string;
  let subscriptionId: string;
  let quoteId: string;

  const call = (key: string, method: string, path: string, body?: unknown, idempotencyKey?: string) =>
    fetch(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const other = (method: string, path: string, body?: unknown, idempotencyKey?: string) => call(otherKey.key, method, path, body, idempotencyKey);
  const balance = async () => (await (await call(ownKey, "GET", `/v1/customers/${buyer}/billing`)).json()).credits.total;

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
      body: JSON.stringify({ name: "e2e isolation" }),
    });
    ownKey = (await created.json()).key;

    const project = (await db.query("SELECT id FROM project ORDER BY created_at LIMIT 1")).rows[0].id;
    const userId = (await db.query('SELECT id FROM "user" LIMIT 1')).rows[0].id;
    const apiKeyId = (await db.query("SELECT id FROM api_key WHERE last_four = $1 ORDER BY created_at DESC LIMIT 1", [ownKey.slice(-4)])).rows[0].id;

    // Planted: a second project with its own backend key, as the dashboard would make it.
    const otherProject = randomUUID();
    await db.query("INSERT INTO project (id, name) VALUES ($1, 'planted-other')", [otherProject]);
    await db.query(`INSERT INTO api_key (id, project_id, environment, name, key_hash, last_four, created_by) VALUES ($1, $2, 'sandbox', 'planted-other', $3, $4, $5)`, [
      randomUUID(), otherProject, otherKey.keyHash, otherKey.lastFour, userId,
    ]);
    await db.query(`INSERT INTO return_origin (id, project_id, environment, origin, created_by) VALUES ($1, $2, 'sandbox', 'https://a.example', $3)`, [randomUUID(), otherProject, userId]);

    // Planted in this project: a paid pack (benefits applied through the real code) and an active subscription.
    const customerId = randomUUID();
    await db.query("INSERT INTO customer (id, project_id, external_customer_id) VALUES ($1, $2, $3)", [customerId, project, buyer]);
    const snapshot = {
      source: "catalog", catalogVersion: 1, product: { ref: "planted-pack", name: "Pack", kind: "credit_pack" }, variant: { ref: "v", name: "V", attributes: {} },
      quantity: 1, unitAmount: 500, amount: 500, currency: "USD", benefits: [{ kind: "credits", amount: 100 }], metadata: {},
    };
    checkoutId = randomUUID();
    await db.query(
      `INSERT INTO checkout (id, project_id, environment, customer_id, api_key_id, idempotency_key, payload_hash, return_url, snapshot, expires_at,
                             money_status, paypal_capture_id, captured_amount, captured_currency, source_version)
       VALUES ($1, $2, 'sandbox', $3, $4, $5, 'planted', 'https://a.example/r', $6, now() + interval '1 hour', 'captured', $7, 500, 'USD', 1)`,
      [checkoutId, project, customerId, apiKeyId, `planted-${checkoutId}`, JSON.stringify(snapshot), `PLANTED-CAP-${checkoutId}`],
    );
    const { applyCheckoutBenefits } = await import("../../packages/db/src/index");
    await applyCheckoutBenefits(checkoutId);
    subscriptionId = randomUUID();
    await db.query(
      `INSERT INTO subscription (id, project_id, environment, customer_id, checkout_id, product_ref, paypal_plan_id, paypal_subscription_id, status)
       VALUES ($1, $2, 'sandbox', $3, $4, 'planted-plan', 'P-PLANTED', $5, 'active')`,
      [subscriptionId, project, customerId, checkoutId, `I-PLANTED-ISO-${subscriptionId}`],
    );

    const quote = await call(ownKey, "POST", "/v1/quotes", { externalCustomerId: buyer, item: { ref: "iso", name: "Iso" }, unitAmount: 300, currency: "USD" }, `iso-${buyer}`);
    expect(quote.status).toBe(201);
    quoteId = (await quote.json()).id;
    expect((await call(ownKey, "POST", "/v1/credits/consume", { externalCustomerId: buyer, amount: 10, usageId: `iso-job-${buyer}` })).status).toBe(200);
  });

  afterAll(async () => {
    await db.end();
    const { closePools } = await import("../../packages/db/src/index");
    await closePools();
  });

  it("can't read this project's checkout or customer", async () => {
    expect((await other("GET", `/v1/checkouts/${checkoutId}`)).status).toBe(404);
    expect((await other("GET", `/v1/customers/${buyer}/billing`)).status).toBe(404);
    expect((await call(ownKey, "GET", `/v1/checkouts/${checkoutId}`)).status).toBe(200);
  });

  it("can't spend this project's credits or give back its usage", async () => {
    const spend = await other("POST", "/v1/credits/consume", { externalCustomerId: buyer, amount: 10, usageId: `iso-job-${buyer}` });
    expect(spend.status).toBe(422);
    expect((await spend.json()).error.code).toBe("insufficient_credits");
    expect((await other("POST", `/v1/usage/iso-job-${buyer}/compensate`)).status).toBe(404);
    expect(await balance()).toBe(90);
  });

  it("can't cancel this project's subscription", async () => {
    expect((await other("POST", `/v1/subscriptions/${subscriptionId}/cancel`)).status).toBe(404);
    expect((await db.query("SELECT status, cancel_requested_at FROM subscription WHERE id = $1", [subscriptionId])).rows[0]).toEqual({ status: "active", cancel_requested_at: null });
  });

  it("can't check or use this project's quote", async () => {
    expect((await other("POST", `/v1/quotes/${quoteId}/check`, { externalCustomerId: buyer })).status).toBe(404);
    const checkout = await other("POST", "/v1/checkouts", { externalCustomerId: buyer, quoteId, returnUrl: "https://a.example/r" }, `iso-checkout-${buyer}`);
    expect(checkout.status).toBe(404);
    expect((await db.query("SELECT count(*)::int AS n FROM checkout WHERE snapshot->'product'->>'ref' = 'iso'")).rows[0].n).toBe(0);
  });
});
