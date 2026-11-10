// Sync invariants against two real Postgres servers: our source and a stand-in merchant database. Writes rows, creates databases
// and runs the real setup command, so it only runs on throwaway databases, with no worker running.
// Needs DATABASE_URL (source) and DESTINATION_OWNER_URL (an owner of the destination server, able to create databases and roles).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSyncPass } from "../../apps/worker/src/sync";
import {
  claimOutboxRow,
  closePools,
  failAbandonedOutboxRows,
  getCheckoutSync,
  loadProjection,
  recordCheckoutMoney,
  recordDelivered,
  recordDestinationOk,
  recordDestinationProblem,
  releaseOutboxRow,
  retryOutboxRow,
  retrySyncNow,
  startSyncStatus,
  applyCheckoutBenefits,
  consumeCredits,
  createCheckout,
  recordSubscriptionState,
  restrictRefundedCheckout,
  saveSubscription,
} from "../../packages/db/src/index";
import { getSourcePool } from "../../packages/db/src/client";
import { checkDestination, closeDestination, deliver, openDestination, type Destination } from "../../packages/sync-postgres/src/index";
import { SCHEMA_VERSION } from "../../packages/sync-postgres/src/destination";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
const db = () => getSourcePool();
const one = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) => (await db().query(text, values)).rows[0] as T;

describe.runIf(process.env.E2E_WRITE_DB === "1" && !!process.env.DESTINATION_OWNER_URL)("sync invariants", { timeout: 120_000 }, () => {
  const ownerUrl = process.env.DESTINATION_OWNER_URL!;
  const syncPassword = randomUUID();
  const urlFor = (database: string, user?: { name: string; password: string }) => {
    const url = new URL(ownerUrl);
    url.pathname = `/${database}`;
    if (user) {
      url.username = user.name;
      url.password = user.password;
    }
    return url.toString();
  };
  const SYNC_USER = { name: "billingrelay_sync", password: syncPassword };
  const ownerDatabase = new URL(ownerUrl).pathname.slice(1);
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  const opened: Destination[] = [];
  const open = (url: string) => {
    const destination = openDestination(url);
    if (!destination || "problem" in destination) throw new Error("destination refused");
    opened.push(destination);
    return destination;
  };

  /** The real command, as the merchant runs it. */
  const setup = (database: string, password = "") =>
    spawnSync("pnpm", ["--silent", "destination:setup"], {
      cwd: REPO,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, DESTINATION_OWNER_URL: urlFor(database), DESTINATION_SYNC_PASSWORD: password },
    });
  let databases = 0;
  const freshDatabase = async () => {
    databases += 1;
    const name = `inv_sync_${databases}_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${name}`);
    return name;
  };
  const inDatabase = async <T>(database: string, work: (client: pg.Client) => Promise<T>) => {
    const client = new pg.Client({ connectionString: urlFor(database) });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };

  let projectId: string;
  let apiKeyId: string;
  let customerId: string;
  let destination: Destination;
  let serial = 0;
  const newCheckout = async (benefits: unknown[] = [{ kind: "access", key: "pro" }], projectOverride?: { projectId: string; customerId: string; apiKeyId: string }) => {
    serial += 1;
    const id = randomUUID();
    const ids = projectOverride ?? { projectId, customerId, apiKeyId };
    const snapshot = {
      source: "merchant", catalogVersion: null, product: { ref: "pro-plan", name: "Pro", kind: "one_time" }, variant: { ref: "v1", name: "V1", attributes: {} },
      quantity: 2, unitAmount: 450, amount: 900, currency: "USD", benefits, metadata: { order: "A-1" },
    };
    await db().query(
      `INSERT INTO checkout (id, project_id, environment, customer_id, api_key_id, idempotency_key, payload_hash, return_url, snapshot, expires_at)
       VALUES ($1, $2, 'sandbox', $3, $4, $5, 'x', 'https://a.example/r', $6, now() + interval '1 hour')`,
      [id, ids.projectId, ids.customerId, ids.apiKeyId, `sync-${serial}-${id}`, JSON.stringify(snapshot)],
    );
    return id;
  };
  const capture = (id: string) =>
    recordCheckoutMoney(id, { moneyStatus: "captured", moneyReason: null, capture: { id: `CAP-${id}`, amount: 900, currency: "USD" } });
  const outboxFor = (id: string) =>
    db().query<{ id: string; source_version: number; status: string; attempts: number; failure_code: string | null }>(
      "SELECT id, source_version, status, attempts, failure_code FROM outbox WHERE entity_id = $1 ORDER BY source_version", [id]);
  const destinationRow = async (table: "purchases" | "access" | "subscriptions", key: string, id: string) =>
    (await owner.query(`SELECT * FROM billingrelay.${table} WHERE ${key} = $1`, [id])).rows[0];
  // Only this test's rows: anything another test left behind is already marked delivered.
  const settleOtherRows = () => db().query("UPDATE outbox SET status = 'delivered' WHERE status <> 'delivered'");
  const pass = () => runSyncPass(destination, () => false);

  beforeAll(async () => {
    projectId = (await one<{ id: string }>("SELECT id FROM project LIMIT 1")).id;
    const userId = (await one<{ id: string }>('SELECT id FROM "user" LIMIT 1')).id;
    apiKeyId = randomUUID();
    customerId = randomUUID();
    await db().query(`INSERT INTO api_key (id, project_id, environment, name, key_hash, last_four, created_by) VALUES ($1, $2, 'sandbox', 'sync', $3, 'xxxx', $4)`, [apiKeyId, projectId, randomUUID(), userId]);
    await db().query(`INSERT INTO customer (id, project_id, external_customer_id) VALUES ($1, $2, $3)`, [customerId, projectId, `app-user-${customerId}`]);

    const result = setup(ownerDatabase, syncPassword);
    if (result.status !== 0) throw new Error(`setup failed: ${result.stdout}${result.stderr}`);
    destination = open(urlFor(ownerDatabase, SYNC_USER));
    await settleOtherRows();
  });

  beforeEach(async () => {
    await startSyncStatus({ state: "checking" });
  });

  afterAll(async () => {
    await Promise.all(opened.map(closeDestination));
    await owner.end();
    await closePools();
  });

  describe("setup", () => {
    it("creates the schema once; running it again changes nothing", async () => {
      const database = await freshDatabase();
      const first = setup(database);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain("Applied 001_initial.sql");
      expect(first.stdout).toContain("Applied 002_subscriptions.sql");
      expect(first.stdout).toContain("Applied 003_credit_balances.sql");
      const tables = () => inDatabase(database, async (c) => (await c.query("SELECT string_agg(table_name, ',' ORDER BY table_name) AS t FROM information_schema.tables WHERE table_schema = 'billingrelay'")).rows[0].t);
      expect(await tables()).toBe("access,credit_balances,customers,purchases,schema_version,subscriptions");
      const second = setup(database);
      expect(second.status).toBe(0);
      expect(second.stdout).not.toContain("Applied");
      expect(await tables()).toBe("access,credit_balances,customers,purchases,schema_version,subscriptions");
    });

    it("upgrades a version 1 destination in place, keeping its rows", async () => {
      const database = await freshDatabase();
      const first = readFileSync(join(REPO, "packages/sync-postgres/migrations/001_initial.sql"), "utf8");
      await inDatabase(database, async (c) => {
        await c.query(first);
        await c.query("INSERT INTO billingrelay.customers (project_id, customer_id, external_customer_id) VALUES (gen_random_uuid(), gen_random_uuid(), 'kept')");
      });
      const result = setup(database);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("001_initial.sql");
      expect(result.stdout).toContain("Applied 002_subscriptions.sql");
      expect(result.stdout).toContain("Applied 003_credit_balances.sql");
      expect(await inDatabase(database, async (c) => (await c.query("SELECT external_customer_id AS id FROM billingrelay.customers")).rows[0].id)).toBe("kept");
    });

    it("stops at a billingrelay schema it didn't make, and leaves it exactly as it was", async () => {
      const database = await freshDatabase();
      const snapshot = () => inDatabase(database, async (c) => (await c.query(`
        SELECT md5(string_agg(table_name || ':' || column_name || ':' || data_type, ',' ORDER BY table_name, column_name)) AS shape,
               (SELECT string_agg(name, ',') FROM billingrelay.purchases) AS data
        FROM information_schema.columns WHERE table_schema = 'billingrelay'`)).rows[0]);
      await inDatabase(database, (c) => c.query("CREATE SCHEMA billingrelay; CREATE TABLE billingrelay.purchases (name text); INSERT INTO billingrelay.purchases VALUES ('theirs')"));
      const before = await snapshot();
      const result = setup(database);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("didn't create it. Nothing was changed.");
      expect(await snapshot()).toEqual(before);
    });

    it("refuses a destination newer than this code", async () => {
      const database = await freshDatabase();
      expect(setup(database).status).toBe(0);
      await inDatabase(database, (c) => c.query(`INSERT INTO billingrelay.schema_version (version) VALUES (${SCHEMA_VERSION + 1})`));
      const result = setup(database);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("newer than this code");
    });

    it("gives the sync role only reads and writes on its own tables", async () => {
      await owner.query("CREATE TABLE IF NOT EXISTS public.app_users (id text PRIMARY KEY, email text); INSERT INTO public.app_users VALUES ('u1', 'u1@example.com') ON CONFLICT DO NOTHING");
      const tries = [
        "CREATE TABLE billingrelay.extra (id int)",
        "CREATE TABLE public.extra (id int)",
        "CREATE SCHEMA other",
        "DROP TABLE billingrelay.purchases",
        "DELETE FROM billingrelay.purchases",
        "TRUNCATE billingrelay.access",
        "ALTER TABLE billingrelay.purchases ADD COLUMN x int",
        "SELECT * FROM public.app_users",
        "UPDATE public.app_users SET email = 'x'",
        "INSERT INTO billingrelay.schema_version (version) VALUES (9)",
      ];
      for (const statement of tries) {
        await expect(destination.pool.query(statement), statement).rejects.toMatchObject({ code: "42501" });
      }
      expect((await owner.query("SELECT email FROM public.app_users WHERE id = 'u1'")).rows[0].email).toBe("u1@example.com");
    });
  });

  describe("checking the destination", () => {
    it("is ready with the sync role", async () => {
      expect(await checkDestination(destination)).toBeNull();
    });

    it("refuses a role that could create things", async () => {
      expect(await checkDestination(open(ownerUrl))).toEqual({ kind: "not_ready", code: "role_too_powerful" });
    });

    it("says what's wrong: no schema, old version, nobody there", async () => {
      const empty = await freshDatabase();
      expect(await checkDestination(open(urlFor(empty)))).toEqual({ kind: "not_ready", code: "schema_mismatch" });
      const old = await freshDatabase();
      expect(setup(old).status).toBe(0);
      await inDatabase(old, (c) => c.query("DELETE FROM billingrelay.schema_version; INSERT INTO billingrelay.schema_version (version) VALUES (7)"));
      expect(await checkDestination(open(urlFor(old, SYNC_USER)))).toEqual({ kind: "not_ready", code: "schema_version_mismatch" });
      expect(await checkDestination(open("postgres://u:p@127.0.0.1:1/none"))).toEqual({ kind: "down", code: "unreachable" });
    });
  });

  describe("delivery", () => {
    it("a subscription and its access reach the destination, with when access ends, and a renewal moves it", async () => {
      await settleOtherRows();
      const snapshot = {
        source: "catalog", catalogVersion: 1, product: { ref: "sync-pro", name: "Pro", kind: "subscription" }, variant: { ref: "monthly", name: "Monthly", attributes: {} },
        quantity: 1, unitAmount: 900, amount: 900, currency: "USD", benefits: [{ kind: "access", key: "pro" }], metadata: {},
      };
      const created = await createCheckout({
        projectId, environment: "sandbox", apiKeyId, externalCustomerId: `sub-${randomUUID()}`, quoteId: null, idempotencyKey: `sync-sub-${randomUUID()}`,
        payloadHash: "x", returnUrl: "https://a.example/r", snapshot: snapshot as never, lifetimeSeconds: 3600,
      });
      if (created.status !== "created") throw new Error("not created");
      const subscription = await saveSubscription({ checkoutId: created.id, paypalPlanId: "P-SYNC", paypalSubscriptionId: `I-${randomUUID()}` });
      const paidThrough = new Date(Date.now() + 30 * 86_400_000);
      const state = { status: "active" as const, approved: true, mismatch: null, nextCheckAt: null };
      await recordSubscriptionState(subscription.id, { ...state, nextBillingTime: paidThrough, payments: [{ paypalSaleId: `S1-${subscription.id}`, amount: 900, currency: "USD", paidAt: new Date(), outcome: "counts" }] });
      await pass();

      const copied = await destinationRow("subscriptions", "subscription_id", subscription.id);
      expect(copied).toMatchObject({ status: "active", product_ref: "sync-pro", cancel_requested: false, review_reason: null });
      expect(new Date(copied.paid_through).getTime()).toBe(paidThrough.getTime());
      const access = (await owner.query("SELECT * FROM billingrelay.access WHERE checkout_id = $1", [created.id])).rows[0];
      expect(new Date(access.active_until).getTime()).toBe(paidThrough.getTime() + 86_400_000);
      expect((await destinationRow("purchases", "checkout_id", created.id)).money_status).toBe("captured");

      const renewedThrough = new Date(paidThrough.getTime() + 30 * 86_400_000);
      await recordSubscriptionState(subscription.id, { ...state, nextBillingTime: renewedThrough, payments: [{ paypalSaleId: `S2-${subscription.id}`, amount: 900, currency: "USD", paidAt: paidThrough, outcome: "counts" }] });
      await pass();
      const renewed = (await owner.query("SELECT * FROM billingrelay.access WHERE checkout_id = $1", [created.id])).rows[0];
      expect(new Date(renewed.active_until).getTime()).toBe(renewedThrough.getTime() + 86_400_000);
      // The old version arriving late changes nothing.
      const old = { entityType: "access_grant" as const, row: { ...(await loadProjection("access_grant", access.grant_id))!.row, sourceVersion: 1, activeUntil: new Date(0) } };
      expect(await deliver(destination, old as never)).toBe("unchanged");
    });

    it("a balance reaches the destination as computed, and a newer one replaces it", async () => {
      await settleOtherRows();
      const id = await newCheckout([{ kind: "credits", amount: 40 }]);
      await capture(id);
      await applyCheckoutBenefits(id);
      await pass();
      const copied = (await owner.query("SELECT * FROM billingrelay.credit_balances WHERE customer_id = $1", [customerId])).rows[0];
      expect(copied).toMatchObject({ external_customer_id: `app-user-${customerId}` });
      // newCheckout grants per unit: quantity 2 of 40.
      expect(Number(copied.packs)).toBeGreaterThanOrEqual(80);
      const before = Number(copied.total);
      const accountId = copied.account_id;
      await consumeCredits({ projectId, environment: "sandbox" }, { externalCustomerId: `app-user-${customerId}`, amount: 3, usageId: `sync-${randomUUID()}` });
      await pass();
      const after = (await owner.query("SELECT total, source_version FROM billingrelay.credit_balances WHERE account_id = $1", [accountId])).rows[0];
      expect(Number(after.total)).toBe(before - 3);
      const stale = { entityType: "credit_account" as const, row: { ...(await loadProjection("credit_account", accountId))!.row, sourceVersion: 1, total: 999 } };
      expect(await deliver(destination, stale as never)).toBe("unchanged");
    });

    it("copies a fixed shape with nothing that names the buyer", async () => {
      const id = await newCheckout();
      await capture(id);
      const projection = await loadProjection("checkout", id);
      expect(projection?.entityType).toBe("checkout");
      expect(Object.keys(projection!.row).sort()).toEqual([
        "amount", "checkoutId", "createdAt", "currency", "customerId", "environment", "expiresAt", "externalCustomerId", "fulfillmentStatus",
        "metadata", "moneyStatus", "paypalCaptureId", "productKind", "productName", "productRef", "projectId", "quantity", "sourceUpdatedAt",
        "sourceVersion", "variantRef",
      ]);
      expect(await deliver(destination, projection!)).toBe("delivered");
      const row = await destinationRow("purchases", "checkout_id", id);
      expect(row).toMatchObject({ money_status: "captured", amount: "900", quantity: 2, variant_ref: "v1", metadata: { order: "A-1" }, external_customer_id: `app-user-${customerId}` });
    });

    it("only a newer version changes a row: repeats and late copies are ignored", async () => {
      const id = await newCheckout();
      await capture(id);
      const v1 = (await loadProjection("checkout", id))!;
      expect(await deliver(destination, v1)).toBe("delivered");
      expect(await deliver(destination, v1)).toBe("unchanged");

      await applyCheckoutBenefits(id);
      const v2 = (await loadProjection("checkout", id))!;
      expect(v2.row.sourceVersion).toBe(v1.row.sourceVersion + 1);
      expect(await deliver(destination, v2)).toBe("delivered");
      // The older copy arrives late.
      expect(await deliver(destination, v1)).toBe("unchanged");
      const row = await destinationRow("purchases", "checkout_id", id);
      expect(row).toMatchObject({ fulfillment_status: "applied", source_version: v2.row.sourceVersion });
    });

    it("20 deliveries of one version at once: one changes the row", async () => {
      const id = await newCheckout();
      await capture(id);
      const projection = (await loadProjection("checkout", id))!;
      const many = open(urlFor(ownerDatabase, SYNC_USER));
      const outcomes = await Promise.all(Array.from({ length: 20 }, () => deliver(many, projection)));
      expect(outcomes.filter((o) => o === "delivered")).toHaveLength(1);
      expect((await owner.query("SELECT count(*)::int AS n FROM billingrelay.purchases WHERE checkout_id = $1", [id])).rows[0].n).toBe(1);
    });

    it("a refund reaches the destination as restricted access, never a deleted row", async () => {
      await settleOtherRows();
      const id = await newCheckout();
      await capture(id);
      await applyCheckoutBenefits(id);
      await pass();
      const grant = await one<{ id: string }>("SELECT id FROM access_grant WHERE checkout_id = $1", [id]);
      expect((await destinationRow("access", "grant_id", grant.id)).status).toBe("active");

      await restrictRefundedCheckout(id, `CAP-${id}`);
      await pass();
      expect((await destinationRow("access", "grant_id", grant.id)).status).toBe("restricted");
      expect((await destinationRow("purchases", "checkout_id", id)).money_status).toBe("refund_review");
      expect(await getCheckoutSync(id)).toBe("delivered");
    });

    it("keeps projects apart", async () => {
      const other = randomUUID();
      await db().query("INSERT INTO project (id, name) VALUES ($1, 'other')", [other]);
      const otherCustomer = randomUUID();
      const otherKey = randomUUID();
      const userId = (await one<{ id: string }>('SELECT id FROM "user" LIMIT 1')).id;
      await db().query(`INSERT INTO api_key (id, project_id, environment, name, key_hash, last_four, created_by) VALUES ($1, $2, 'sandbox', 'o', $3, 'xxxx', $4)`, [otherKey, other, randomUUID(), userId]);
      // The same app user ID in another project is another customer.
      await db().query(`INSERT INTO customer (id, project_id, external_customer_id) VALUES ($1, $2, $3)`, [otherCustomer, other, `app-user-${customerId}`]);
      const id = await newCheckout(undefined, { projectId: other, customerId: otherCustomer, apiKeyId: otherKey });
      await capture(id);
      expect(await deliver(destination, (await loadProjection("checkout", id))!)).toBe("delivered");
      const rows = (await owner.query("SELECT project_id, customer_id FROM billingrelay.customers WHERE external_customer_id = $1 ORDER BY project_id", [`app-user-${customerId}`])).rows;
      expect(rows.map((r) => r.project_id).sort()).toEqual([projectId, other].sort());
    });
  });

  describe("the outbox as the job", () => {
    it("marks delivered up to the version sent, and not past it", async () => {
      await settleOtherRows();
      const id = await newCheckout();
      await capture(id);
      await applyCheckoutBenefits(id);
      const rows = (await outboxFor(id)).rows;
      expect(rows).toHaveLength(2);
      const claimed = (await claimOutboxRow())!;
      await recordDelivered(claimed, { sourceVersion: rows[0]!.source_version, outcome: "delivered", durationMs: 1 });
      expect((await outboxFor(id)).rows.map((r) => r.status)).toEqual(["delivered", "pending"]);
    });

    it("twenty claims at once each get a different row", async () => {
      await settleOtherRows();
      for (let i = 0; i < 10; i += 1) await capture(await newCheckout([]));
      const claims = await Promise.all(Array.from({ length: 20 }, () => claimOutboxRow()));
      const ids = claims.filter((c) => c !== null).map((c) => c!.id);
      expect(ids).toHaveLength(10);
      expect(new Set(ids).size).toBe(10);
      await settleOtherRows();
    });

    it("a destination failure gives the attempt back; a refused row backs off to failed after 8; retry now requeues it", async () => {
      await settleOtherRows();
      const id = await newCheckout([]);
      await capture(id);
      const claimed = (await claimOutboxRow())!;
      await releaseOutboxRow(claimed.id);
      expect((await outboxFor(id)).rows[0]).toMatchObject({ status: "pending", attempts: 0 });

      for (let i = 0; i < 8; i += 1) {
        await db().query("UPDATE outbox SET next_attempt_at = now() WHERE id = $1", [claimed.id]);
        const again = (await claimOutboxRow())!;
        expect(again.id).toBe(claimed.id);
        await retryOutboxRow(again.id, "pg_22003", 3);
      }
      expect((await outboxFor(id)).rows[0]).toMatchObject({ status: "failed", attempts: 8, failure_code: "pg_22003" });
      await db().query("UPDATE outbox SET next_attempt_at = now() WHERE id = $1", [claimed.id]);
      expect(await claimOutboxRow()).toBeNull();
      expect(await getCheckoutSync(id)).toBe("failed");
      expect(Number((await one<{ n: string }>("SELECT count(*) AS n FROM sync_attempt WHERE outbox_id = $1 AND outcome = 'refused'", [claimed.id])).n)).toBe(8);

      expect((await retrySyncNow()).requeued).toBeGreaterThanOrEqual(1);
      expect((await outboxFor(id)).rows[0]).toMatchObject({ status: "pending", attempts: 0, failure_code: null });
      await settleOtherRows();
    });

    it("a worker killed on the last attempt still ends as failed", async () => {
      await settleOtherRows();
      const id = await newCheckout([]);
      await capture(id);
      await db().query("UPDATE outbox SET attempts = 8, next_attempt_at = now() - interval '1 second' WHERE entity_id = $1", [id]);
      await failAbandonedOutboxRows();
      expect((await outboxFor(id)).rows[0]).toMatchObject({ status: "failed", failure_code: "worker_died" });
      await settleOtherRows();
    });
  });

  describe("the sync pass", () => {
    it("a destination that's down uses up no attempts, waits, then catches up", async () => {
      await settleOtherRows();
      const ids = [];
      for (let i = 0; i < 3; i += 1) {
        const id = await newCheckout([]);
        await capture(id);
        ids.push(id);
      }
      await recordDestinationOk();
      const down = open("postgres://u:p@127.0.0.1:1/none");
      for (let i = 0; i < 5; i += 1) {
        await db().query("UPDATE sync_status SET next_try_at = now()");
        await runSyncPass(down, () => false);
      }
      const status = await one<{ state: string; code: string; failures: number; down_since: Date | null }>("SELECT * FROM sync_status");
      expect(status).toMatchObject({ state: "down", code: "unreachable" });
      expect(status.down_since).not.toBeNull();
      for (const id of ids) expect((await outboxFor(id)).rows[0]).toMatchObject({ status: "pending", attempts: 0 });
      for (const id of ids) expect(await getCheckoutSync(id)).toBe("pending");

      await db().query("UPDATE sync_status SET next_try_at = now()");
      await pass();
      expect((await one<{ state: string }>("SELECT state FROM sync_status")).state).toBe("ok");
      for (const id of ids) expect(await getCheckoutSync(id)).toBe("delivered");
    });

    it("waits between checks while the destination is down, longer each time, at most about a minute", async () => {
      await recordDestinationOk();
      const waits: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        await recordDestinationProblem({ state: "down", code: "unreachable" });
        waits.push((await one<{ s: number }>("SELECT extract(epoch FROM next_try_at - now())::float8 AS s FROM sync_status")).s);
      }
      expect(waits[0]).toBeGreaterThan(3.5);
      expect(waits[0]).toBeLessThan(6.5);
      expect(waits[1]).toBeGreaterThan(waits[0]!);
      for (const wait of waits) expect(wait).toBeLessThanOrEqual(72.5);
      expect(waits.at(-1)).toBeGreaterThan(47);
      await recordDestinationOk();
      expect(await one("SELECT failures, code, down_since FROM sync_status")).toEqual({ failures: 0, code: null, down_since: null });
    });

    it("not ready: says why, and the worker never writes", async () => {
      await settleOtherRows();
      const id = await newCheckout([]);
      await capture(id);
      await runSyncPass(open(ownerUrl), () => false);
      expect(await one("SELECT state, code FROM sync_status")).toEqual({ state: "not_ready", code: "role_too_powerful" });
      expect(await destinationRow("purchases", "checkout_id", id)).toBeUndefined();
      expect((await outboxFor(id)).rows[0]).toMatchObject({ status: "pending", attempts: 0 });
      await settleOtherRows();
    });

    it("permission taken away mid-way pauses everything, and it recovers once given back", async () => {
      await settleOtherRows();
      const id = await newCheckout([]);
      await capture(id);
      await recordDestinationOk();
      await owner.query("REVOKE INSERT ON billingrelay.purchases FROM billingrelay_sync");
      try {
        await pass();
        expect(await one("SELECT state, code FROM sync_status")).toEqual({ state: "not_ready", code: "permission_denied" });
        expect((await outboxFor(id)).rows[0]).toMatchObject({ status: "pending", attempts: 0 });
      } finally {
        await owner.query("GRANT INSERT ON billingrelay.purchases TO billingrelay_sync");
      }
      await db().query("UPDATE sync_status SET next_try_at = now()");
      await pass();
      expect(await getCheckoutSync(id)).toBe("delivered");
    });

    it("sync says not_configured with no destination, and pending for a checkout nothing happened to", async () => {
      const id = await newCheckout([]);
      await startSyncStatus({ state: "not_configured" });
      expect(await getCheckoutSync(id)).toBe("not_configured");
      await startSyncStatus({ state: "checking" });
      expect(await getCheckoutSync(id)).toBe("pending");
    });
  });
});
