// Runs against a live stack (see README). Reads go through HTTP, like a real caller. The second block plants checkouts, events and
// sync rows straight into the source database (labelled `planted`) and changes the destination state, so run it only on a throwaway database.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const RATE_LIMIT_WINDOW_MS = 11_000;
const ROUTES = [
  "/admin/billing/attention",
  "/admin/billing/checkouts",
  "/admin/billing/events",
  "/admin/billing/deliveries",
  "/admin/customers/anyone/trace",
];
const PAGES = ["/admin/billing", "/admin/customers/anyone"];

const request = (path: string, init: RequestInit = {}) => fetch(`${BASE_URL}${path}`, { redirect: "manual", ...init });

describe("dashboard without a session", () => {
  it.each(ROUTES)("GET %s returns 401", async (path) => {
    const res = await request(path);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it.each(PAGES)("page %s redirects to /login", async (path) => {
    const res = await request(path);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });
});

describe.runIf(process.env.E2E_WRITE_DB === "1")("dashboard with planted rows", { timeout: 60_000 }, () => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const run = Date.now().toString(36);
  // Things that must never appear in a response: the buyer, the payload and secrets.
  const BUYER_EMAIL = `planted-buyer-${run}@example.com`;
  const BUYER_NAME = `PlantedBuyerName${run}`;
  const KEY_HASH = `planted-key-hash-${run}`;
  const SECRET_ENCRYPTED = `planted-secret-${run}`;
  const customers = {
    synced: `planted-synced-${run}`,
    unsynced: `planted-unsynced-${run}`,
    eur: `planted-eur-${run}`,
    unclear: `planted-unclear-${run}`,
    pending: `planted user@${run}`,
  };
  const checkouts = { synced: randomUUID(), unsynced: randomUUID(), eur: randomUUID(), unclear: randomUUID(), pending: randomUUID() };
  const orderB = `PLANTED-ORD-B-${run}`;
  const captureA = `PLANTED-CAP-A-${run}`;
  const captureB = `PLANTED-CAP-B-${run}`;
  const failedEventId = randomUUID();
  const failedOutboxId = randomUUID();
  let cookie: string;
  let plantedConnection = false;
  let previousSyncStatus: Record<string, unknown> | undefined;
  const bodies: string[] = [];

  const admin = async (path: string) => {
    const res = await request(path, { headers: { Cookie: cookie } });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: JSON.parse(text) };
  };

  type Row = Record<string, unknown> & { id: string };
  const list = async (path: string, query: Record<string, string>) => {
    const res = await admin(`${path}?${new URLSearchParams(query)}`);
    expect(res.status).toBe(200);
    return res.body as { rows: Row[]; total: number; totals?: { currency: string; count: number; amount: number }[] };
  };
  const ids = (rows: Row[]) => rows.map((row) => row.id);

  const one = async <T>(text: string, values: unknown[] = []) => (await db.query(text, values)).rows[0] as T;

  async function plant() {
    const projectId = (await one<{ id: string }>("SELECT id FROM project ORDER BY created_at LIMIT 1")).id;
    const userId = (await one<{ id: string }>('SELECT id FROM "user" LIMIT 1')).id;
    const apiKeyId = randomUUID();
    await db.query(
      `INSERT INTO api_key (id, project_id, environment, name, key_hash, last_four, created_by) VALUES ($1, $2, 'sandbox', 'planted', $3, 'xxxx', $4)`,
      [apiKeyId, projectId, KEY_HASH, userId],
    );

    let connection = await one<{ id: string } | undefined>(`SELECT id FROM paypal_connection WHERE project_id = $1 AND environment = 'sandbox'`, [projectId]);
    if (!connection) {
      plantedConnection = true;
      connection = { id: randomUUID() };
      await db.query(
        `INSERT INTO paypal_connection (id, project_id, environment, client_id, secret_encrypted, webhook_status, webhook_error)
         VALUES ($1, $2, 'sandbox', 'planted-client', $3, 'not_registered', 'webhook_setup_failed')`,
        [connection.id, projectId, SECRET_ENCRYPTED],
      );
    }

    const customerIds: Record<string, string> = {};
    for (const [name, external] of Object.entries(customers)) {
      customerIds[name] = randomUUID();
      await db.query(`INSERT INTO customer (id, project_id, external_customer_id) VALUES ($1, $2, $3)`, [customerIds[name], projectId, external]);
    }

    const snapshot = (amount: number, currency: string) =>
      JSON.stringify({
        source: "merchant", catalogVersion: null, product: { ref: "planted-poster", name: "Planted poster", kind: "one_time" }, variant: null,
        quantity: 1, unitAmount: amount, amount, currency, benefits: [{ kind: "access", key: "planted-access" }], metadata: {},
      });
    const addCheckout = (
      name: keyof typeof checkouts,
      values: { amount: number; currency: string; money: string; fulfillment: string; ago: string; order?: string; capture?: string; captureRequested?: boolean },
    ) =>
      db.query(
        `INSERT INTO checkout (id, project_id, environment, customer_id, api_key_id, idempotency_key, payload_hash, return_url, snapshot,
                               expires_at, money_status, fulfillment_status, paypal_order_id, paypal_capture_id, capture_requested_at,
                               source_version, created_at, updated_at)
         VALUES ($1, $2, 'sandbox', $3, $4, $5, 'planted', 'https://merchant.example.com/r', $6,
                 now() - $7::interval + interval '1 hour', $8, $9, $10, $11, CASE WHEN $12 THEN now() - $7::interval + interval '1 minute' END,
                 2, now() - $7::interval, now() - $7::interval)`,
        [checkouts[name], projectId, customerIds[name], apiKeyId, `planted-${name}-${run}`, snapshot(values.amount, values.currency), values.ago,
         values.money, values.fulfillment, values.order ?? null, values.capture ?? null, values.captureRequested ?? false],
      );
    await addCheckout("synced", { amount: 1500, currency: "USD", money: "captured", fulfillment: "applied", ago: "3 hours", capture: captureA, captureRequested: true });
    await addCheckout("unsynced", { amount: 2900, currency: "USD", money: "captured", fulfillment: "applied", ago: "2 hours", order: orderB, capture: captureB, captureRequested: true });
    await addCheckout("eur", { amount: 4000, currency: "EUR", money: "captured", fulfillment: "applied", ago: "90 minutes", captureRequested: true });
    await addCheckout("unclear", { amount: 1000, currency: "USD", money: "approved", fulfillment: "pending", ago: "2 days", captureRequested: true });
    await addCheckout("pending", { amount: 500, currency: "USD", money: "pending", fulfillment: "pending", ago: "5 minutes" });

    // B: effect and grant, the grant delivered, the checkout refused 8 times.
    const grantB = randomUUID();
    await db.query(
      `INSERT INTO billing_effect (id, project_id, checkout_id, paypal_payment_id, kind, created_at) VALUES ($1, $2, $3, $4, 'access', now() - interval '2 hours' + interval '3 minutes')`,
      [randomUUID(), projectId, checkouts.unsynced, captureB],
    );
    await db.query(
      `INSERT INTO access_grant (id, project_id, environment, customer_id, access_key, checkout_id, paypal_payment_id, created_at, updated_at)
       VALUES ($1, $2, 'sandbox', $3, 'planted-access', $4, $5, now() - interval '2 hours' + interval '3 minutes', now() - interval '2 hours' + interval '3 minutes')`,
      [grantB, projectId, customerIds.unsynced, checkouts.unsynced, captureB],
    );
    const addOutbox = (id: string, entityType: string, entityId: string, status: string, attempts: number, code: string | null, at: string) =>
      db.query(
        `INSERT INTO outbox (id, project_id, entity_type, entity_id, source_version, status, attempts, failure_code, created_at, delivered_at)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, now() - $8::interval, CASE WHEN $5 = 'delivered' THEN now() - $8::interval + interval '2 seconds' END)`,
        [id, projectId, entityType, entityId, status, attempts, code, at],
      );
    const addAttempt = (outboxId: string, outcome: string, code: string | null, durationMs: number, at: string) =>
      db.query(`INSERT INTO sync_attempt (id, outbox_id, outcome, code, duration_ms, created_at) VALUES ($1, $2, $3, $4, $5, now() - $6::interval)`, [
        randomUUID(), outboxId, outcome, code, durationMs, at,
      ]);
    await addOutbox(failedOutboxId, "checkout", checkouts.unsynced, "failed", 8, "planted_column_mismatch", "117 minutes");
    await addAttempt(failedOutboxId, "refused", "planted_column_mismatch", 41, "116 minutes");
    await addAttempt(failedOutboxId, "refused", "planted_column_mismatch", 37, "100 minutes");
    const grantOutbox = randomUUID();
    await addOutbox(grantOutbox, "access_grant", grantB, "delivered", 1, null, "117 minutes");
    await addAttempt(grantOutbox, "delivered", null, 12, "116 minutes");
    // A: delivered. EUR: still waiting.
    const syncedOutbox = randomUUID();
    await addOutbox(syncedOutbox, "checkout", checkouts.synced, "delivered", 1, null, "170 minutes");
    await addAttempt(syncedOutbox, "delivered", null, 9, "169 minutes");
    await addOutbox(randomUUID(), "checkout", checkouts.eur, "pending", 0, null, "80 minutes");

    // Events carry PayPal's real shape, including the buyer's details, which must never be returned.
    const addEvent = (id: string, type: string, status: string, attempts: number, code: string | null, payload: object, at: string) =>
      db.query(
        `INSERT INTO paypal_event (id, connection_id, event_id, event_type, payload, status, attempts, failure_code, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - $9::interval)`,
        [id, connection.id, `WH-PLANTED-${randomUUID()}`, type, JSON.stringify(payload), status, attempts, code, at],
      );
    const payer = { email_address: BUYER_EMAIL, name: { given_name: BUYER_NAME } };
    await addEvent(randomUUID(), "CHECKOUT.ORDER.APPROVED", "processed", 1, null, { resource: { id: orderB, purchase_units: [{ custom_id: checkouts.unsynced }], payer } }, "118 minutes");
    await addEvent(randomUUID(), "PAYMENT.CAPTURE.COMPLETED", "processed", 1, null, {
      resource: { id: captureB, custom_id: checkouts.unsynced, supplementary_data: { related_ids: { order_id: orderB } }, payer },
    }, "118 minutes");
    await addEvent(failedEventId, "PAYMENT.CAPTURE.REFUNDED", "failed", 8, "planted_paypal_unreachable", {
      resource: { id: `PLANTED-REFUND-${run}`, links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureA}` }], payer },
    }, "30 minutes");

    previousSyncStatus = await one("SELECT * FROM sync_status WHERE id = 1");
    await db.query(`
      INSERT INTO sync_status (id, state, code, down_since) VALUES (1, 'down', 'planted_connection_refused', now() - interval '1 hour')
      ON CONFLICT (id) DO UPDATE SET state = 'down', code = 'planted_connection_refused', down_since = now() - interval '1 hour'`);
  }

  beforeAll(async () => {
    await plant();
    const signIn = () =>
      fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL },
        body: JSON.stringify({ email: process.env.OPERATOR_EMAIL, password: process.env.OPERATOR_PASSWORD }),
      });
    let signedIn = await signIn();
    if (signedIn.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WINDOW_MS));
      signedIn = await signIn();
    }
    expect(signedIn.status).toBe(200);
    cookie = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.includes("session_token"))!;
  }, 30_000);

  afterAll(async () => {
    if (previousSyncStatus) {
      const { state, code, down_since: downSince } = previousSyncStatus;
      await db.query("UPDATE sync_status SET state = $1, code = $2, down_since = $3 WHERE id = 1", [state, code, downSince]);
    } else {
      await db.query("DELETE FROM sync_status WHERE id = 1");
    }
    await db.end();
    // Sign-in allows 3 attempts per 10s in one shared bucket locally; the next file signs in without retrying.
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WINDOW_MS));
  }, RATE_LIMIT_WINDOW_MS + 5_000);

  it("'Paid, not synced' finds captured checkouts the merchant's database doesn't have yet", async () => {
    const { rows } = await list("/admin/billing/checkouts", { money: "captured", sync: "not_delivered", limit: "100" });
    expect(ids(rows)).toEqual(expect.arrayContaining([checkouts.unsynced, checkouts.eur]));
    expect(ids(rows)).not.toContain(checkouts.synced);
    expect(ids(rows)).not.toContain(checkouts.pending);
    for (const row of rows) {
      expect(row.money).toBe("captured");
      expect(row.sync).not.toBe("delivered");
    }
  });

  it("filters by each status on its own", async () => {
    const failed = await list("/admin/billing/checkouts", { sync: "failed", limit: "100" });
    expect(ids(failed.rows)).toContain(checkouts.unsynced);
    expect(ids(failed.rows)).not.toContain(checkouts.eur);

    const delivered = await list("/admin/billing/checkouts", { sync: "delivered", limit: "100" });
    expect(ids(delivered.rows)).toContain(checkouts.synced);

    const approved = await list("/admin/billing/checkouts", { money: "approved", limit: "100" });
    expect(ids(approved.rows)).toEqual(expect.arrayContaining([checkouts.unclear]));
    expect(approved.rows.every((row) => row.money === "approved")).toBe(true);

    const fulfillment = await list("/admin/billing/checkouts", { fulfillment: "pending", limit: "100" });
    expect(ids(fulfillment.rows)).toEqual(expect.arrayContaining([checkouts.unclear, checkouts.pending]));
    expect(ids(fulfillment.rows)).not.toContain(checkouts.unsynced);
  });

  it("totals each currency on its own, over every matching row", async () => {
    const query = { money: "captured", sync: "not_delivered" };
    const first = await list("/admin/billing/checkouts", { ...query, limit: "100" });
    const rows: Row[] = [...first.rows];
    for (let offset = 100; offset < first.total; offset += 100) {
      rows.push(...(await list("/admin/billing/checkouts", { ...query, limit: "100", offset: String(offset) })).rows);
    }
    const expected = new Map<string, { count: number; amount: number }>();
    for (const row of rows) {
      const total = expected.get(row.currency as string) ?? { count: 0, amount: 0 };
      expected.set(row.currency as string, { count: total.count + 1, amount: total.amount + (row.amount as number) });
    }
    expect(first.totals).toEqual([...expected].sort(([a], [b]) => a.localeCompare(b)).map(([currency, total]) => ({ currency, ...total })));
    expect(first.totals!.map((total) => total.currency)).toEqual(expect.arrayContaining(["EUR", "USD"]));
    expect(first.total).toBe(rows.length);
  });

  it("pages in SQL", async () => {
    const page1 = await list("/admin/billing/checkouts", { limit: "1" });
    const page2 = await list("/admin/billing/checkouts", { limit: "1", offset: "1" });
    expect(page1.rows).toHaveLength(1);
    expect(page2.rows).toHaveLength(1);
    expect(page1.rows[0]!.id).not.toBe(page2.rows[0]!.id);
    expect(page1.total).toBe(page2.total);
  });

  it.each([
    ["/admin/billing/checkouts", "money=bogus"],
    ["/admin/billing/checkouts", "limit=1000"],
    ["/admin/billing/checkouts", "customer=someone"],
    ["/admin/billing/events", "status=bogus"],
    ["/admin/billing/deliveries", "entityType=user"],
  ])("refuses %s?%s with 400", async (path, query) => {
    const res = await admin(`${path}?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });

  it("lists events with codes and statuses, linked to their checkout, never the payload", async () => {
    const failed = await list("/admin/billing/events", { status: "failed", limit: "100" });
    const event = failed.rows.find((row) => row.id === failedEventId);
    expect(event).toMatchObject({
      eventType: "PAYMENT.CAPTURE.REFUNDED",
      status: "failed",
      attempts: 8,
      failureCode: "planted_paypal_unreachable",
      checkoutId: checkouts.synced,
      externalCustomerId: customers.synced,
    });
    expect(Object.keys(event!)).not.toContain("payload");
    expect(failed.rows.every((row) => row.status === "failed")).toBe(true);

    const byType = await list("/admin/billing/events", { eventType: "CHECKOUT.ORDER.APPROVED", limit: "100" });
    expect(byType.rows.length).toBeGreaterThan(0);
    expect(byType.rows.every((row) => row.eventType === "CHECKOUT.ORDER.APPROVED")).toBe(true);
    expect(byType.rows.some((row) => row.checkoutId === checkouts.unsynced)).toBe(true);
  });

  it("lists deliveries with their last attempt's code and duration", async () => {
    const failed = await list("/admin/billing/deliveries", { status: "failed", limit: "100" });
    expect(failed.rows.find((row) => row.id === failedOutboxId)).toMatchObject({
      entityType: "checkout",
      checkoutId: checkouts.unsynced,
      externalCustomerId: customers.unsynced,
      status: "failed",
      attempts: 8,
      failureCode: "planted_column_mismatch",
      lastAttempt: { outcome: "refused", code: "planted_column_mismatch", durationMs: 37 },
    });
    expect(failed.rows.every((row) => row.status === "failed")).toBe(true);

    const grants = await list("/admin/billing/deliveries", { entityType: "access_grant", limit: "100" });
    expect(grants.rows.every((row) => row.entityType === "access_grant")).toBe(true);
  });

  it("a subscription's changes are deliveries too, linked to their checkout", async () => {
    const owner = await one<{ project_id: string; customer_id: string }>("SELECT project_id, customer_id FROM checkout WHERE id = $1", [checkouts.synced]);
    const subscriptionId = randomUUID();
    await db.query(
      `INSERT INTO subscription (id, project_id, environment, customer_id, checkout_id, product_ref, paypal_plan_id, paypal_subscription_id, status)
       VALUES ($1, $2, 'sandbox', $3, $4, 'planted-plan', 'P-PLANTED', $5, 'active')`,
      [subscriptionId, owner.project_id, owner.customer_id, checkouts.synced, `I-PLANTED-${run}`],
    );
    await db.query(`INSERT INTO outbox (id, project_id, entity_type, entity_id, source_version) VALUES ($1, $2, 'subscription', $3, 1)`, [
      randomUUID(),
      owner.project_id,
      subscriptionId,
    ]);
    const rows = await list("/admin/billing/deliveries", { entityType: "subscription", limit: "100" });
    expect(rows.rows.find((row) => row.entityId === subscriptionId)).toMatchObject({ entityType: "subscription", checkoutId: checkouts.synced });
  });

  it("names what needs attention", async () => {
    const { status, body } = await admin("/admin/billing/attention");
    expect(status).toBe(200);
    expect(body.failedEvents).toBeGreaterThanOrEqual(1);
    expect(body.failedDeliveries).toBeGreaterThanOrEqual(1);
    expect(body.unclearCheckouts).toBeGreaterThanOrEqual(1);
    expect(body.destination).toMatchObject({ state: "down", code: "planted_connection_refused" });
    if (plantedConnection) expect(body.webhook).toEqual({ status: "not_registered", code: "webhook_setup_failed" });
  });

  it("traces one customer in time order, down to the failed attempt's code", async () => {
    const { status, body } = await admin(`/admin/customers/${encodeURIComponent(customers.unsynced)}/trace`);
    expect(status).toBe(200);
    expect(body.externalCustomerId).toBe(customers.unsynced);
    expect(body.checkouts).toHaveLength(1);
    const [checkout] = body.checkouts;
    expect(checkout).toMatchObject({ id: checkouts.unsynced, money: "captured", sync: "failed", paypalOrderId: orderB, paypalCaptureId: captureB });

    const steps = checkout.steps as { kind: string; at: string; [key: string]: unknown }[];
    const times = steps.map((step) => step.at);
    expect(times).toEqual([...times].sort());
    expect(steps.map((step) => step.kind)).toEqual([
      "checkout_created",
      "capture_requested",
      "event",
      "event",
      "effect",
      "grant",
      "outbox",
      "outbox",
      "sync_attempt",
      "sync_attempt",
      "sync_attempt",
    ]);
    expect(steps.filter((step) => step.kind === "sync_attempt" && step.outcome === "refused")).toEqual([
      expect.objectContaining({ code: "planted_column_mismatch", durationMs: 41, outboxId: failedOutboxId }),
      expect.objectContaining({ code: "planted_column_mismatch", durationMs: 37, outboxId: failedOutboxId }),
    ]);
  });

  it("finds a customer whose ID needs encoding, and 404s an unknown one", async () => {
    const found = await admin(`/admin/customers/${encodeURIComponent(customers.pending)}/trace`);
    expect(found.status).toBe(200);
    expect(found.body.checkouts.map((checkout: Row) => checkout.id)).toEqual([checkouts.pending]);
    expect((await admin(`/admin/customers/${encodeURIComponent(`nobody-${run}`)}/trace`)).status).toBe(404);
  });

  it("the pages open with a session", async () => {
    expect((await request("/admin/billing", { headers: { Cookie: cookie } })).status).toBe(200);
    const trace = await request(`/admin/customers/${encodeURIComponent(customers.unsynced)}`, { headers: { Cookie: cookie } });
    expect(trace.status).toBe(200);
    bodies.push(await trace.text());
  });

  // Last, so it covers every body the tests above received.
  it("no response carries the buyer, the payload or a secret", () => {
    expect(bodies.length).toBeGreaterThan(10);
    const forbidden = [BUYER_EMAIL, BUYER_NAME, "email_address", '"payload"', KEY_HASH, SECRET_ENCRYPTED, process.env.OPERATOR_PASSWORD!];
    for (const body of bodies) {
      for (const value of forbidden) expect(body).not.toContain(value);
    }
  });
});
