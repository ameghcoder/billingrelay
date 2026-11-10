// Credit ledger invariants against real Postgres, with no PayPal. Writes rows, so only on a throwaway database with no worker running.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyCheckoutBenefits,
  claimCheckoutForBenefits,
  closePools,
  compensateUsage,
  consumeCredits,
  createCheckout,
  expireLapsedCredits,
  recordCheckoutMoney,
  recordSubscriptionState,
  restrictRefundedCheckout,
  saveSubscription,
} from "../../packages/db/src/index";
import { getSourcePool } from "../../packages/db/src/client";

const db = () => getSourcePool();
const one = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) => (await db().query(text, values)).rows[0] as T;
const count = async (text: string, values: unknown[] = []) => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM ${text}`, values)).n);
const DAY = 86_400_000;

describe.runIf(process.env.E2E_WRITE_DB === "1")("credit invariants", { timeout: 90_000 }, () => {
  let projectId: string;
  let apiKeyId: string;
  const scope = () => ({ projectId, environment: "sandbox" as const });

  const snapshot = (kind: "credit_pack" | "subscription", credits: number, quantity = 1) => ({
    source: "catalog",
    catalogVersion: 1,
    product: { ref: kind === "credit_pack" ? "pack" : "pro", name: "P", kind },
    variant: { ref: "v", name: "V", attributes: {} },
    quantity,
    unitAmount: 500,
    amount: 500 * quantity,
    currency: "USD",
    benefits: kind === "subscription" ? [{ kind: "access", key: "pro" }, { kind: "credits", amount: credits }] : [{ kind: "credits", amount: credits }],
    metadata: {},
  });

  const checkoutFor = async (customer: string, snap: object) => {
    const created = await createCheckout({
      projectId,
      environment: "sandbox",
      apiKeyId,
      externalCustomerId: customer,
      quoteId: null,
      idempotencyKey: `inv-credit-${randomUUID()}`,
      payloadHash: "x",
      returnUrl: "https://a.example/r",
      snapshot: snap as never,
      lifetimeSeconds: 3600,
    });
    if (created.status !== "created") throw new Error("not created");
    return created.id;
  };

  /** A paid pack: captured, then its benefits applied. */
  const paidPack = async (customer: string, credits: number, quantity = 1) => {
    const id = await checkoutFor(customer, snapshot("credit_pack", credits, quantity));
    await recordCheckoutMoney(id, { moneyStatus: "captured", moneyReason: null, capture: { id: `CAP-${id}`, amount: 500 * quantity, currency: "USD" } });
    await applyCheckoutBenefits(id);
    return id;
  };

  const customer = () => `inv-credit-${randomUUID()}`;
  const balanceOf = async (externalCustomerId: string) => {
    const result = await consumeCredits(scope(), { externalCustomerId, amount: 1_000_000_000, usageId: `peek-${randomUUID()}` });
    return result.status === "insufficient" ? result.balance.total : NaN;
  };
  /** Every account's entries add up to what its lots hold, restricted or not. */
  const ledgerAddsUp = async () =>
    count(`(
      SELECT a.id FROM credit_account a
      WHERE (SELECT coalesce(sum(amount), 0) FROM credit_entry WHERE account_id = a.id)
         <> (SELECT coalesce(sum(remaining), 0) FROM credit_lot WHERE account_id = a.id)
    ) broken`);

  beforeAll(async () => {
    projectId = (await one<{ id: string }>("SELECT id FROM project LIMIT 1")).id;
    const userId = (await one<{ id: string }>('SELECT id FROM "user" LIMIT 1')).id;
    apiKeyId = randomUUID();
    await db().query(`INSERT INTO api_key (id, project_id, environment, name, key_hash, last_four, created_by) VALUES ($1, $2, 'sandbox', 'inv-credit', $3, 'xxxx', $4)`, [
      apiKeyId,
      projectId,
      randomUUID(),
      userId,
    ]);
  });

  afterAll(async () => {
    expect(await ledgerAddsUp()).toBe(0);
    await closePools();
  });

  it("a paid pack grants once, per unit, however often its benefits are applied", async () => {
    const buyer = customer();
    const id = await checkoutFor(buyer, snapshot("credit_pack", 5_000, 2));
    await recordCheckoutMoney(id, { moneyStatus: "captured", moneyReason: null, capture: { id: `CAP-${id}`, amount: 1000, currency: "USD" } });
    await Promise.all(Array.from({ length: 10 }, () => applyCheckoutBenefits(id)));
    expect(await count("credit_lot WHERE checkout_id = $1", [id])).toBe(1);
    expect(await balanceOf(buyer)).toBe(10_000);
    expect((await one<{ fulfillment_status: string }>("SELECT fulfillment_status FROM checkout WHERE id = $1", [id])).fulfillment_status).toBe("applied");
  });

  it("a pack paid before the ledger existed is picked up and granted", async () => {
    const buyer = customer();
    const id = await checkoutFor(buyer, snapshot("credit_pack", 300));
    await recordCheckoutMoney(id, { moneyStatus: "captured", moneyReason: null, capture: { id: `CAP-${id}`, amount: 500, currency: "USD" } });
    // Labelled: what M06's code left behind for a pack.
    await db().query("UPDATE checkout SET fulfillment_reason = 'waiting_for_credit_ledger', next_check_at = NULL WHERE id = $1", [id]);
    let claimed: string | null = null;
    for (let i = 0; i < 50 && claimed !== id; i++) {
      claimed = await claimCheckoutForBenefits();
      if (claimed) await applyCheckoutBenefits(claimed);
    }
    expect(claimed).toBe(id);
    expect(await balanceOf(buyer)).toBe(300);
  });

  it("50 spends at once for more than the balance: never below zero, exactly what fits", async () => {
    const buyer = customer();
    await paidPack(buyer, 100);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => consumeCredits(scope(), { externalCustomerId: buyer, amount: 3, usageId: `race-${buyer}-${i}` })));
    expect(results.filter((result) => result.status === "debited")).toHaveLength(33);
    expect(results.filter((result) => result.status === "insufficient")).toHaveLength(17);
    expect(await balanceOf(buyer)).toBe(1);
  });

  it("20 spends at once with one usageId: one debit, and every caller gets the same answer", async () => {
    const buyer = customer();
    await paidPack(buyer, 100);
    const usageId = `same-${buyer}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeCredits(scope(), { externalCustomerId: buyer, amount: 7, usageId })));
    expect(results.every((result) => result.status === "debited" && result.debited === 7)).toBe(true);
    expect(await count("credit_entry WHERE usage_id = $1 AND kind = 'debit'", [usageId])).toBe(1);
    expect(await balanceOf(buyer)).toBe(93);
  });

  it("a usageId can't be reused for another amount or another customer", async () => {
    const buyer = customer();
    const other = customer();
    await paidPack(buyer, 50);
    await paidPack(other, 50);
    const usageId = `taken-${buyer}`;
    expect((await consumeCredits(scope(), { externalCustomerId: buyer, amount: 5, usageId })).status).toBe("debited");
    expect((await consumeCredits(scope(), { externalCustomerId: buyer, amount: 6, usageId })).status).toBe("usage_conflict");
    expect((await consumeCredits(scope(), { externalCustomerId: other, amount: 5, usageId })).status).toBe("usage_conflict");
    expect(await balanceOf(other)).toBe(50);
  });

  it("two customers racing for one new usageId: one debit, the other changes nothing", async () => {
    const [a, b] = [customer(), customer()];
    await paidPack(a, 20);
    await paidPack(b, 20);
    const usageId = `race-two-${a}`;
    const results = await Promise.all([a, b].map((externalCustomerId) => consumeCredits(scope(), { externalCustomerId, amount: 4, usageId })));
    expect(results.map((result) => result.status).sort()).toEqual(["debited", "usage_conflict"]);
    expect((await balanceOf(a)) + (await balanceOf(b))).toBe(36);
  });

  it("a failed usage gets one compensation, even asked twice at once", async () => {
    const buyer = customer();
    await paidPack(buyer, 40);
    const usageId = `comp-${buyer}`;
    await consumeCredits(scope(), { externalCustomerId: buyer, amount: 15, usageId });
    const results = await Promise.all(Array.from({ length: 5 }, () => compensateUsage(scope(), usageId)));
    expect(results.every((result) => result.status === "compensated" && result.compensated === 15)).toBe(true);
    expect(await count("credit_entry WHERE usage_id = $1 AND kind = 'compensation'", [usageId])).toBe(1);
    expect(await balanceOf(buyer)).toBe(40);
    expect((await compensateUsage(scope(), `never-${buyer}`)).status).toBe("not_found");
  });

  it("monthly credits go first, end with the paid month, and a renewal ends the last month's", async () => {
    const buyer = customer();
    await paidPack(buyer, 100);
    const checkoutId = await checkoutFor(buyer, snapshot("subscription", 50));
    const subscription = await saveSubscription({ checkoutId, paypalPlanId: "P-INV", paypalSubscriptionId: `I-${randomUUID()}` });
    const paidThrough = new Date(Date.now() + 30 * DAY);
    const state = { status: "active" as const, approved: true, mismatch: null, nextCheckAt: null };
    const sale = (id: string, paidAt: Date) => ({ paypalSaleId: id, amount: 500, currency: "USD", paidAt, outcome: "counts" as const });
    await Promise.all(Array.from({ length: 5 }, () => recordSubscriptionState(subscription.id, { ...state, nextBillingTime: paidThrough, payments: [sale(`M1-${checkoutId}`, new Date())] })));

    const monthly = await one<{ amount: string; expires_at: Date }>("SELECT amount, expires_at FROM credit_lot WHERE subscription_id = $1", [subscription.id]);
    expect(Number(monthly.amount)).toBe(50);
    expect(monthly.expires_at.getTime()).toBe(paidThrough.getTime() + DAY);

    const spent = await consumeCredits(scope(), { externalCustomerId: buyer, amount: 30, usageId: `monthly-first-${buyer}` });
    expect(spent.status === "debited" && spent.balance).toMatchObject({ monthly: 20, packs: 100 });

    const renewedThrough = new Date(paidThrough.getTime() + 30 * DAY);
    await recordSubscriptionState(subscription.id, { ...state, nextBillingTime: renewedThrough, payments: [sale(`M2-${checkoutId}`, paidThrough)] });
    expect(await count("credit_lot WHERE subscription_id = $1", [subscription.id])).toBe(2);
    expect(await count("credit_entry e JOIN credit_lot l ON l.id = e.lot_id WHERE l.subscription_id = $1 AND e.kind = 'expiry' AND e.amount = -20", [subscription.id])).toBe(1);
    expect(await balanceOf(buyer)).toBe(150);
  });

  it("past their end, monthly credits can't be spent, and the sweep writes their expiry", async () => {
    const buyer = customer();
    const checkoutId = await checkoutFor(buyer, snapshot("subscription", 25));
    const subscription = await saveSubscription({ checkoutId, paypalPlanId: "P-INV", paypalSubscriptionId: `I-${randomUUID()}` });
    await recordSubscriptionState(subscription.id, {
      status: "active",
      approved: true,
      mismatch: null,
      nextCheckAt: null,
      nextBillingTime: new Date(Date.now() + 30 * DAY),
      payments: [{ paypalSaleId: `X-${checkoutId}`, amount: 500, currency: "USD", paidAt: new Date(), outcome: "counts" }],
    });
    // Labelled: the month moved into the past.
    await db().query("UPDATE credit_lot SET expires_at = now() - interval '1 second' WHERE subscription_id = $1", [subscription.id]);
    expect((await consumeCredits(scope(), { externalCustomerId: buyer, amount: 1, usageId: `late-${buyer}` })).status).toBe("insufficient");
    for (let i = 0; i < 20 && (await count("credit_lot WHERE subscription_id = $1 AND remaining > 0", [subscription.id])) > 0; i++) await expireLapsedCredits();
    expect(await count("credit_entry e JOIN credit_lot l ON l.id = e.lot_id WHERE l.subscription_id = $1 AND e.kind = 'expiry' AND e.amount = -25", [subscription.id])).toBe(1);
  });

  it("a refunded pack can't be spent; the customer's other credits still can", async () => {
    const buyer = customer();
    const refunded = await paidPack(buyer, 60);
    await paidPack(buyer, 10);
    await consumeCredits(scope(), { externalCustomerId: buyer, amount: 5, usageId: `before-refund-${buyer}` });
    expect(await restrictRefundedCheckout(refunded, `CAP-${refunded}`)).toBe(true);
    expect(await count("credit_lot WHERE checkout_id = $1 AND status = 'restricted'", [refunded])).toBe(1);
    const spend = await consumeCredits(scope(), { externalCustomerId: buyer, amount: 11, usageId: `after-refund-${buyer}` });
    expect(spend.status).toBe("insufficient");
    expect((await consumeCredits(scope(), { externalCustomerId: buyer, amount: 10, usageId: `rest-${buyer}` })).status).toBe("debited");
  });

  it("an unknown customer has nothing to spend", async () => {
    expect(await consumeCredits(scope(), { externalCustomerId: `nobody-${randomUUID()}`, amount: 1, usageId: `nobody-${randomUUID()}` })).toMatchObject({
      status: "insufficient",
      balance: { total: 0 },
    });
  });

  it("every account's ledger adds up to what its lots hold", async () => {
    expect(await ledgerAddsUp()).toBe(0);
  });
});
