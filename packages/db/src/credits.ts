import { allocateDebit, type Allocation, type CreditBalance, type CreditBucket } from "@billingrelay/core/credits";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { getDb } from "./client";
import type { ProjectScope } from "./schema";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Runner = Pick<Tx, "execute">;

// The worker's sweep for lapsed monthly credits: accounts per pass, so one pass stays short.
const EXPIRY_ACCOUNTS_PER_PASS = 25;

type Account = { id: string; project_id: string; environment: string };

/** The customer's credit account, made if needed, locked for the rest of the transaction. */
async function lockAccount(tx: Runner, owner: { projectId: string; environment: string; customerId: string }): Promise<Account> {
  await tx.execute(sql`
    INSERT INTO credit_account (id, project_id, environment, customer_id)
    VALUES (${uuidv7()}, ${owner.projectId}, ${owner.environment}, ${owner.customerId})
    ON CONFLICT (project_id, environment, customer_id) DO NOTHING`);
  const { rows } = await tx.execute<Account>(sql`
    SELECT id, project_id, environment FROM credit_account
    WHERE project_id = ${owner.projectId} AND environment = ${owner.environment} AND customer_id = ${owner.customerId}
    FOR UPDATE`);
  return rows[0]!;
}

/** Every change to an account's balance, with its outbox row in the same transaction. */
async function bumpAccount(tx: Runner, account: Account): Promise<void> {
  const { rows } = await tx.execute<{ source_version: number }>(sql`
    UPDATE credit_account SET source_version = source_version + 1, updated_at = now() WHERE id = ${account.id} RETURNING source_version`);
  await tx.execute(sql`
    INSERT INTO outbox (id, project_id, entity_type, entity_id, source_version)
    VALUES (${uuidv7()}, ${account.project_id}, 'credit_account', ${account.id}, ${rows[0]!.source_version})`);
}

const addEntry = (
  tx: Runner,
  account: Account,
  entry: { kind: "grant" | "debit" | "compensation" | "expiry"; amount: number; lotId?: string | null; usageId?: string | null; debitId?: string | null; allocation?: Allocation | null },
) =>
  tx.execute<{ id: string }>(sql`
    INSERT INTO credit_entry (id, project_id, environment, account_id, kind, amount, lot_id, usage_id, debit_id, allocation)
    VALUES (${uuidv7()}, ${account.project_id}, ${account.environment}, ${account.id}, ${entry.kind}, ${entry.amount}, ${entry.lotId ?? null},
            ${entry.usageId ?? null}, ${entry.debitId ?? null}, ${entry.allocation ? JSON.stringify(entry.allocation) : null}::jsonb)
    RETURNING id`);

/** Lots that can be spent right now. The end time is checked here, so a late sweep can't let expired credits be used. */
const spendable = sql`status = 'active' AND remaining > 0 AND (expires_at IS NULL OR expires_at > now())`;

export async function readBalance(db: Runner, accountId: string | null): Promise<CreditBalance> {
  if (!accountId) return { monthly: 0, packs: 0, total: 0, monthlyEndsAt: null };
  const { rows } = await db.execute<{ bucket: CreditBucket; remaining: string; ends_at: string | null }>(sql`
    SELECT bucket, sum(remaining)::bigint AS remaining, max(expires_at) AS ends_at
    FROM credit_lot WHERE account_id = ${accountId} AND ${spendable}
    GROUP BY bucket`);
  const monthly = rows.find((row) => row.bucket === "monthly");
  const packs = Number(rows.find((row) => row.bucket === "pack")?.remaining ?? 0);
  const monthlyAmount = Number(monthly?.remaining ?? 0);
  return { monthly: monthlyAmount, packs, total: monthlyAmount + packs, monthlyEndsAt: monthly?.ends_at ? new Date(monthly.ends_at).toISOString() : null };
}

export type CreditGrant = {
  projectId: string;
  environment: string;
  customerId: string;
  paypalPaymentId: string;
  bucket: CreditBucket;
  amount: number;
  expiresAt: Date | null;
  checkoutId: string;
  subscriptionId: string | null;
};

/**
 * One grant per payment, inside the caller's transaction. A new month's credits end the last month's first, with an expiry
 * entry for what was left: unused monthly credits don't carry over.
 */
export async function grantCredits(tx: Tx, grant: CreditGrant): Promise<void> {
  const account = await lockAccount(tx, grant);
  const lotId = uuidv7();
  const { rows } = await tx.execute(sql`
    INSERT INTO credit_lot (id, account_id, bucket, amount, remaining, expires_at, paypal_payment_id, checkout_id, subscription_id)
    VALUES (${lotId}, ${account.id}, ${grant.bucket}, ${grant.amount}, ${grant.amount}, ${grant.expiresAt?.toISOString() ?? null},
            ${grant.paypalPaymentId}, ${grant.checkoutId}, ${grant.subscriptionId})
    ON CONFLICT (paypal_payment_id) DO NOTHING
    RETURNING id`);
  if (rows.length === 0) return;

  if (grant.subscriptionId) {
    const { rows: ended } = await tx.execute<{ id: string; remaining: string }>(sql`
      UPDATE credit_lot l SET remaining = 0
      FROM (SELECT id, remaining FROM credit_lot WHERE subscription_id = ${grant.subscriptionId} AND id <> ${lotId} AND remaining > 0) old
      WHERE l.id = old.id
      RETURNING l.id, old.remaining`);
    for (const lot of ended) await addEntry(tx, account, { kind: "expiry", amount: -Number(lot.remaining), lotId: lot.id });
  }
  await addEntry(tx, account, { kind: "grant", amount: grant.amount, lotId });
  await bumpAccount(tx, account);
}

type DebitRow = { id: string; account_id: string; amount: string };

const findDebit = async (db: Runner, scope: ProjectScope, usageId: string) =>
  (
    await db.execute<DebitRow>(sql`
      SELECT id, account_id, amount FROM credit_entry
      WHERE project_id = ${scope.projectId} AND environment = ${scope.environment} AND usage_id = ${usageId} AND kind = 'debit'`)
  ).rows[0] ?? null;

const customerOf = async (db: Runner, scope: ProjectScope, externalCustomerId: string) =>
  (
    await db.execute<{ id: string }>(sql`
      SELECT id FROM customer WHERE project_id = ${scope.projectId} AND external_customer_id = ${externalCustomerId}`)
  ).rows[0]?.id ?? null;

const accountOf = async (db: Runner, scope: ProjectScope, customerId: string) =>
  (
    await db.execute<{ id: string }>(sql`
      SELECT id FROM credit_account WHERE project_id = ${scope.projectId} AND environment = ${scope.environment} AND customer_id = ${customerId}`)
  ).rows[0]?.id ?? null;

export type ConsumeResult =
  | { status: "debited"; debited: number; balance: CreditBalance }
  | { status: "insufficient"; balance: CreditBalance }
  | { status: "usage_conflict" };

/**
 * One debit per usage ID, never past zero. The account row is locked first, so spends at once happen one after another and
 * a repeat finds the first one's debit. A repeat returns the same amount and the balance as it is now.
 */
export async function consumeCredits(scope: ProjectScope, request: { externalCustomerId: string; amount: number; usageId: string }): Promise<ConsumeResult> {
  return getDb().transaction(async (tx): Promise<ConsumeResult> => {
    const customerId = await customerOf(tx, scope, request.externalCustomerId);
    const accountId = customerId && (await accountOf(tx, scope, customerId));
    if (!customerId || !accountId) {
      const used = await findDebit(tx, scope, request.usageId);
      return used ? { status: "usage_conflict" } : { status: "insufficient", balance: await readBalance(tx, null) };
    }
    const account = await lockAccount(tx, { ...scope, customerId });

    const before = await findDebit(tx, scope, request.usageId);
    if (before) {
      const same = before.account_id === account.id && -Number(before.amount) === request.amount;
      return same ? { status: "debited", debited: request.amount, balance: await readBalance(tx, account.id) } : { status: "usage_conflict" };
    }

    const { rows: lots } = await tx.execute<{ id: string; bucket: CreditBucket; remaining: string; expires_at: string | null; created_at: string }>(sql`
      SELECT id, bucket, remaining, expires_at, created_at FROM credit_lot WHERE account_id = ${account.id} AND ${spendable}`);
    const allocation = allocateDebit(
      lots.map((lot) => ({
        id: lot.id,
        bucket: lot.bucket,
        remaining: Number(lot.remaining),
        expiresAt: lot.expires_at ? new Date(lot.expires_at) : null,
        createdAt: new Date(lot.created_at),
      })),
      request.amount,
    );
    if (!allocation) return { status: "insufficient", balance: await readBalance(tx, account.id) };

    // Another customer's spend may have taken this usage ID since the lookup: that one wins, and nothing here changes.
    const { rows: debit } = await tx.execute(sql`
      INSERT INTO credit_entry (id, project_id, environment, account_id, kind, amount, usage_id, allocation)
      VALUES (${uuidv7()}, ${scope.projectId}, ${scope.environment}, ${account.id}, 'debit', ${-request.amount}, ${request.usageId},
              ${JSON.stringify(allocation)}::jsonb)
      ON CONFLICT (project_id, environment, usage_id) WHERE kind = 'debit' DO NOTHING
      RETURNING id`);
    if (debit.length === 0) return { status: "usage_conflict" };

    for (const part of allocation) {
      const { rows: taken } = await tx.execute(sql`
        UPDATE credit_lot SET remaining = remaining - ${part.amount} WHERE id = ${part.lotId} AND remaining >= ${part.amount} RETURNING id`);
      // The account lock makes this impossible; if it ever happens, nothing in this transaction stays.
      if (taken.length === 0) throw new Error("Credit lot changed under a locked account");
    }
    await bumpAccount(tx, account);
    return { status: "debited", debited: request.amount, balance: await readBalance(tx, account.id) };
  });
}

export type CompensateResult = { status: "compensated"; compensated: number; balance: CreditBalance } | { status: "not_found" };

/** Gives one debit back, once, to the lots it came from. A lot that ended meanwhile gets its credits back but can't spend them. */
export async function compensateUsage(scope: ProjectScope, usageId: string): Promise<CompensateResult> {
  return getDb().transaction(async (tx): Promise<CompensateResult> => {
    const debit = await findDebit(tx, scope, usageId);
    if (!debit) return { status: "not_found" };
    const { rows: owners } = await tx.execute<Account & { customer_id: string }>(sql`
      SELECT id, project_id, environment, customer_id FROM credit_account WHERE id = ${debit.account_id}`);
    const account = await lockAccount(tx, { projectId: owners[0]!.project_id, environment: owners[0]!.environment, customerId: owners[0]!.customer_id });
    const amount = -Number(debit.amount);

    const { rows: added } = await tx.execute(sql`
      INSERT INTO credit_entry (id, project_id, environment, account_id, kind, amount, usage_id, debit_id)
      VALUES (${uuidv7()}, ${scope.projectId}, ${scope.environment}, ${account.id}, 'compensation', ${amount}, ${usageId}, ${debit.id})
      ON CONFLICT (debit_id) WHERE kind = 'compensation' DO NOTHING
      RETURNING id`);
    if (added.length > 0) {
      const { rows } = await tx.execute<{ allocation: Allocation }>(sql`SELECT allocation FROM credit_entry WHERE id = ${debit.id}`);
      for (const part of rows[0]!.allocation) {
        await tx.execute(sql`UPDATE credit_lot SET remaining = remaining + ${part.amount} WHERE id = ${part.lotId}`);
      }
      await bumpAccount(tx, account);
    }
    return { status: "compensated", compensated: amount, balance: await readBalance(tx, account.id) };
  });
}

/**
 * Refunded: the lots that payment granted can't be spent any more. Credits already spent stay spent. Inside the refund's
 * transaction. The account is locked before its lots, the same order a spend uses, so the two can't deadlock.
 */
export async function restrictCreditsFrom(tx: Tx, checkoutId: string): Promise<void> {
  const { rows: owners } = await tx.execute<{ project_id: string; environment: string; customer_id: string }>(sql`
    SELECT DISTINCT a.project_id, a.environment, a.customer_id
    FROM credit_lot l JOIN credit_account a ON a.id = l.account_id
    WHERE l.checkout_id = ${checkoutId} AND l.status = 'active'`);
  for (const owner of owners) {
    const account = await lockAccount(tx, { projectId: owner.project_id, environment: owner.environment, customerId: owner.customer_id });
    const { rows } = await tx.execute(sql`
      UPDATE credit_lot SET status = 'restricted' WHERE checkout_id = ${checkoutId} AND account_id = ${account.id} AND status = 'active' RETURNING id`);
    if (rows.length > 0) await bumpAccount(tx, account);
  }
}

/**
 * Writes the expiry entry for monthly credits whose month ended without a renewal, so the ledger and the destination's balance
 * say so. Spending never waited for this: it checks the end time itself.
 */
export async function expireLapsedCredits(): Promise<number> {
  const { rows: due } = await getDb().execute<{ account_id: string }>(sql`
    SELECT DISTINCT account_id FROM credit_lot WHERE expires_at <= now() AND remaining > 0 LIMIT ${EXPIRY_ACCOUNTS_PER_PASS}`);
  for (const { account_id: accountId } of due) {
    await getDb().transaction(async (tx) => {
      const { rows } = await tx.execute<Account>(sql`SELECT id, project_id, environment FROM credit_account WHERE id = ${accountId} FOR UPDATE`);
      const account = rows[0]!;
      const { rows: ended } = await tx.execute<{ id: string; remaining: string }>(sql`
        UPDATE credit_lot l SET remaining = 0
        FROM (SELECT id, remaining FROM credit_lot WHERE account_id = ${accountId} AND expires_at <= now() AND remaining > 0) old
        WHERE l.id = old.id
        RETURNING l.id, old.remaining`);
      for (const lot of ended) await addEntry(tx, account, { kind: "expiry", amount: -Number(lot.remaining), lotId: lot.id });
      if (ended.length > 0) await bumpAccount(tx, account);
    });
  }
  return due.length;
}

export async function getCustomerBalance(scope: ProjectScope, customerId: string): Promise<{ balance: CreditBalance; version: number }> {
  const db = getDb();
  const { rows } = await db.execute<{ id: string; source_version: number }>(sql`
    SELECT id, source_version FROM credit_account WHERE project_id = ${scope.projectId} AND environment = ${scope.environment} AND customer_id = ${customerId}`);
  return { balance: await readBalance(db, rows[0]?.id ?? null), version: rows[0]?.source_version ?? 0 };
}
