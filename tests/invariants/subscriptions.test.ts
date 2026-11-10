// Subscription invariants against real Postgres, with no PayPal: what PayPal said is handed in as it would be read.
// Writes rows, so it only runs on a throwaway database with no worker running.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimSubscriptionForCheck,
  closePools,
  createCheckout,
  findCheckout,
  recordSubscriptionState,
  saveSubscription,
  type SubscriptionPaymentRead,
  type SubscriptionRead,
} from "../../packages/db/src/index";
import { getSourcePool } from "../../packages/db/src/client";
import { showMoneyStatus } from "../../packages/core/src/checkouts";

const db = () => getSourcePool();
const one = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) => (await db().query(text, values)).rows[0] as T;
const count = async (text: string, values: unknown[] = []) => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM ${text}`, values)).n);

const HOUR = 3600_000;
const PRICE = 900;
const snapshotFor = (ref: string, kind = "subscription") => ({
  source: "catalog",
  catalogVersion: 1,
  product: { ref, name: "Pro", kind },
  variant: { ref: "monthly", name: "Monthly", attributes: {} },
  quantity: 1,
  unitAmount: PRICE,
  amount: PRICE,
  currency: "USD",
  benefits: kind === "subscription" ? [{ kind: "access", key: "pro" }] : [],
  metadata: {},
});

const sale = (id: string, paidAt: Date, extra: Partial<SubscriptionPaymentRead> = {}): SubscriptionPaymentRead => ({
  paypalSaleId: id,
  amount: PRICE,
  currency: "USD",
  paidAt,
  outcome: "counts",
  ...extra,
});

const read = (extra: Partial<SubscriptionRead>): SubscriptionRead => ({
  status: "active",
  approved: true,
  nextBillingTime: null,
  mismatch: null,
  payments: [],
  nextCheckAt: null,
  ...extra,
});

describe.runIf(process.env.E2E_WRITE_DB === "1")("subscription invariants", { timeout: 60_000 }, () => {
  let projectId: string;
  let apiKeyId: string;
  let serial = 0;

  const newCustomer = () => `inv-sub-${randomUUID()}`;

  const startCheckout = async (externalCustomerId: string, ref = "pro", kind = "subscription") => {
    serial += 1;
    return createCheckout({
      projectId,
      environment: "sandbox",
      apiKeyId,
      externalCustomerId,
      quoteId: null,
      idempotencyKey: `inv-sub-${serial}-${randomUUID()}`,
      payloadHash: "x",
      returnUrl: "https://a.example/r",
      snapshot: snapshotFor(ref, kind) as never,
      lifetimeSeconds: 3600,
    });
  };

  /** A subscription checkout whose buyer clicked Pay. */
  const startedSubscription = async () => {
    const created = await startCheckout(newCustomer());
    if (created.status !== "created") throw new Error("not created");
    const subscription = await saveSubscription({ checkoutId: created.id, paypalPlanId: "P-INV", paypalSubscriptionId: `I-${randomUUID()}` });
    return { checkoutId: created.id, subscription };
  };

  const subscriptionRow = (id: string) =>
    one<{ status: string; review_reason: string | null; paid_through: Date | null; source_version: number }>("SELECT * FROM subscription WHERE id = $1", [id]);
  const grantOf = (id: string) => one<{ id: string; active_until: Date; status: string; source_version: number } | undefined>("SELECT * FROM access_grant WHERE subscription_id = $1", [id]);
  const outboxRows = (type: string, id: string) => count("outbox WHERE entity_type = $1 AND entity_id = $2", [type, id]);

  beforeAll(async () => {
    projectId = (await one<{ id: string }>("SELECT id FROM project LIMIT 1")).id;
    const userId = (await one<{ id: string }>('SELECT id FROM "user" LIMIT 1')).id;
    apiKeyId = randomUUID();
    await db().query(`INSERT INTO api_key (id, project_id, environment, name, key_hash, last_four, created_by) VALUES ($1, $2, 'sandbox', 'inv-sub', $3, 'xxxx', $4)`, [
      apiKeyId,
      projectId,
      randomUUID(),
      userId,
    ]);
  });

  afterAll(async () => {
    await closePools();
  });

  it("the first payment, seen 20 times at once: one payment, one grant, captured once", async () => {
    const { checkoutId, subscription } = await startedSubscription();
    const paidAt = new Date();
    const nextBillingTime = new Date(paidAt.getTime() + 30 * 24 * HOUR);
    await Promise.all(Array.from({ length: 20 }, () => recordSubscriptionState(subscription.id, read({ nextBillingTime, payments: [sale(`S-${checkoutId}`, paidAt)] }))));

    expect(await count("subscription_payment WHERE subscription_id = $1", [subscription.id])).toBe(1);
    const grant = (await grantOf(subscription.id))!;
    expect(grant.status).toBe("active");
    expect(grant.active_until.getTime()).toBe(nextBillingTime.getTime() + 24 * HOUR);
    expect((await subscriptionRow(subscription.id)).paid_through?.getTime()).toBe(nextBillingTime.getTime());

    const checkout = (await findCheckout(checkoutId))!;
    expect([checkout.moneyStatus, checkout.fulfillmentStatus, checkout.paypalCaptureId]).toEqual(["captured", "applied", `S-${checkoutId}`]);
    expect(await outboxRows("checkout", checkoutId)).toBe(1);
    expect(await outboxRows("access_grant", grant.id)).toBe(1);
    expect(await outboxRows("subscription", subscription.id)).toBe(1);
  });

  it("a renewal moves paid time forward once; seeing it again changes nothing", async () => {
    const { subscription } = await startedSubscription();
    const first = new Date();
    const second = new Date(first.getTime() + 30 * 24 * HOUR);
    const third = new Date(second.getTime() + 30 * 24 * HOUR);
    await recordSubscriptionState(subscription.id, read({ nextBillingTime: second, payments: [sale(`A-${subscription.id}`, first)] }));
    const grantBefore = (await grantOf(subscription.id))!;

    const renewal = read({ nextBillingTime: third, payments: [sale(`A-${subscription.id}`, first), sale(`B-${subscription.id}`, second)] });
    await Promise.all(Array.from({ length: 10 }, () => recordSubscriptionState(subscription.id, renewal)));

    const grant = (await grantOf(subscription.id))!;
    expect(grant.id).toBe(grantBefore.id);
    expect(grant.active_until.getTime()).toBe(third.getTime() + 24 * HOUR);
    expect(grant.source_version).toBe(2);
    expect(await outboxRows("access_grant", grant.id)).toBe(2);
    expect(await count("subscription_payment WHERE subscription_id = $1", [subscription.id])).toBe(2);
  });

  it("a read with an earlier billing time and no new payment never shortens paid time", async () => {
    const { subscription } = await startedSubscription();
    const later = new Date(Date.now() + 30 * 24 * HOUR);
    await recordSubscriptionState(subscription.id, read({ nextBillingTime: later, payments: [sale(`C-${subscription.id}`, new Date())] }));
    await recordSubscriptionState(subscription.id, read({ nextBillingTime: new Date(Date.now() + HOUR), payments: [sale(`C-${subscription.id}`, new Date())] }));
    expect((await subscriptionRow(subscription.id)).paid_through?.getTime()).toBe(later.getTime());
    expect((await grantOf(subscription.id))!.active_until.getTime()).toBe(later.getTime() + 24 * HOUR);
  });

  it("cancelled keeps the paid time and the grant", async () => {
    const { subscription } = await startedSubscription();
    const paidThrough = new Date(Date.now() + 30 * 24 * HOUR);
    await recordSubscriptionState(subscription.id, read({ nextBillingTime: paidThrough, payments: [sale(`D-${subscription.id}`, new Date())] }));
    await recordSubscriptionState(subscription.id, read({ status: "cancelled", nextBillingTime: null, payments: [sale(`D-${subscription.id}`, new Date())] }));
    const row = await subscriptionRow(subscription.id);
    expect([row.status, row.paid_through?.getTime()]).toEqual(["cancelled", paidThrough.getTime()]);
    expect((await grantOf(subscription.id))!).toMatchObject({ status: "active" });
  });

  it("a first payment of the wrong amount grants nothing and goes to a person", async () => {
    const { checkoutId, subscription } = await startedSubscription();
    await recordSubscriptionState(subscription.id, read({ nextBillingTime: new Date(Date.now() + 30 * 24 * HOUR), payments: [sale(`E-${subscription.id}`, new Date(), { amount: 100, outcome: "amount_mismatch" })] }));
    expect(await grantOf(subscription.id)).toBeUndefined();
    expect((await subscriptionRow(subscription.id)).review_reason).toBe("amount_mismatch");
    const checkout = (await findCheckout(checkoutId))!;
    expect([checkout.moneyStatus, checkout.moneyReason]).toEqual(["unresolved", "amount_mismatch"]);
  });

  it("a subscription that isn't ours counts none of its payments, even matching ones", async () => {
    const { subscription } = await startedSubscription();
    await recordSubscriptionState(subscription.id, read({ mismatch: "plan_mismatch", nextBillingTime: new Date(Date.now() + 30 * 24 * HOUR), payments: [sale(`F-${subscription.id}`, new Date())] }));
    expect(await grantOf(subscription.id)).toBeUndefined();
    expect((await one<{ outcome: string }>("SELECT outcome FROM subscription_payment WHERE subscription_id = $1", [subscription.id])).outcome).toBe("plan_mismatch");
  });

  it("a later wrong amount doesn't extend paid time, and what was paid stays", async () => {
    const { subscription } = await startedSubscription();
    const paidThrough = new Date(Date.now() + 30 * 24 * HOUR);
    await recordSubscriptionState(subscription.id, read({ nextBillingTime: paidThrough, payments: [sale(`G1-${subscription.id}`, new Date())] }));
    await recordSubscriptionState(subscription.id, read({ nextBillingTime: new Date(paidThrough.getTime() + 30 * 24 * HOUR), payments: [sale(`G2-${subscription.id}`, paidThrough, { amount: 1, outcome: "amount_mismatch" })] }));
    expect((await subscriptionRow(subscription.id)).paid_through?.getTime()).toBe(paidThrough.getTime());
    expect((await grantOf(subscription.id))!.active_until.getTime()).toBe(paidThrough.getTime() + 24 * HOUR);
  });

  it("approved with no payment yet: the checkout waits, and can't read as expired", async () => {
    const { checkoutId, subscription } = await startedSubscription();
    await db().query("UPDATE checkout SET expires_at = now() - interval '1 minute' WHERE id = $1", [checkoutId]);
    await recordSubscriptionState(subscription.id, read({ status: "pending", approved: true }));
    const checkout = (await findCheckout(checkoutId))!;
    expect(showMoneyStatus(checkout)).toBe("approved");
  });

  it("10 checkouts at once for one customer's subscription: one starts, the rest are told it exists", async () => {
    const customer = newCustomer();
    const results = await Promise.all(Array.from({ length: 10 }, () => startCheckout(customer)));
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "subscription_exists")).toHaveLength(9);
    // Another product, or a one-time purchase, isn't held up.
    expect((await startCheckout(customer, "team")).status).toBe("created");
    expect((await startCheckout(customer, "pro", "one_time")).status).toBe("created");
  });

  it("a cancelled or abandoned subscription doesn't block starting again", async () => {
    const { checkoutId, subscription } = await startedSubscription();
    const customer = (await findCheckout(checkoutId))!.externalCustomerId;
    await recordSubscriptionState(subscription.id, read({ nextBillingTime: new Date(Date.now() + 30 * 24 * HOUR), payments: [sale(`H-${subscription.id}`, new Date())] }));
    expect((await startCheckout(customer)).status).toBe("subscription_exists");
    await recordSubscriptionState(subscription.id, read({ status: "cancelled" }));
    const again = await startCheckout(customer);
    expect(again.status).toBe("created");
    // Left unapproved past its hour: free again.
    await db().query("UPDATE checkout SET expires_at = now() - interval '1 minute' WHERE id = $1", [(again as { id: string }).id]);
    expect((await startCheckout(customer)).status).toBe("created");
  });

  it("a due subscription is claimed by one of 5 workers", async () => {
    const { subscription } = await startedSubscription();
    await db().query("UPDATE subscription SET next_check_at = NULL WHERE id <> $1", [subscription.id]);
    await db().query("UPDATE subscription SET next_check_at = now() - interval '1 second' WHERE id = $1", [subscription.id]);
    const claims = await Promise.all(Array.from({ length: 5 }, () => claimSubscriptionForCheck()));
    expect(claims.filter((id) => id === subscription.id)).toHaveLength(1);
    expect(claims.filter((id) => id !== null)).toHaveLength(1);
  });
});
