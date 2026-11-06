import type { QuoteSnapshot } from "@billingrelay/core/quotes";
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";
import { getDb } from "./client";
import { ensureCustomer } from "./customers";
import { customer, quote, type ProjectScope } from "./schema";

export type QuoteRecord = {
  id: string;
  externalCustomerId: string;
  snapshot: QuoteSnapshot;
  expiresAt: Date;
  isExpired: boolean;
};

const quoteColumns = {
  id: quote.id,
  externalCustomerId: customer.externalCustomerId,
  snapshot: quote.snapshot,
  expiresAt: quote.expiresAt,
  // The database's clock, so the web server's clock can't change the answer.
  isExpired: sql<boolean>`${quote.expiresAt} <= now()`,
};

const inScope = ({ projectId, environment }: ProjectScope) => and(eq(quote.projectId, projectId), eq(quote.environment, environment));

export async function getQuote(scope: ProjectScope, id: string): Promise<QuoteRecord | null> {
  const [row] = await getDb()
    .select(quoteColumns)
    .from(quote)
    .innerJoin(customer, eq(customer.id, quote.customerId))
    .where(and(inScope(scope), eq(quote.id, id)));
  return row ?? null;
}

export async function findQuoteByKey(scope: ProjectScope, idempotencyKey: string): Promise<(QuoteRecord & { payloadHash: string }) | null> {
  const [row] = await getDb()
    .select({ ...quoteColumns, payloadHash: quote.payloadHash })
    .from(quote)
    .innerJoin(customer, eq(customer.id, quote.customerId))
    .where(and(inScope(scope), eq(quote.idempotencyKey, idempotencyKey)));
  return row ?? null;
}

/**
 * Stores the customer (if new) and the quote together. Returns null if another request with this
 * key got in first, and rolls back so a different customer in this request leaves no row behind.
 */
export async function createQuote(
  values: ProjectScope & {
    apiKeyId: string;
    externalCustomerId: string;
    idempotencyKey: string;
    payloadHash: string;
    snapshot: QuoteSnapshot;
    expiresInSeconds: number;
  },
): Promise<QuoteRecord | null> {
  const { projectId, environment, externalCustomerId, idempotencyKey, expiresInSeconds } = values;
  try {
    return await getDb().transaction(async (tx) => {
      const customerId = await ensureCustomer(tx, projectId, externalCustomerId);

      const [created] = await tx
        .insert(quote)
        .values({
          projectId,
          environment,
          customerId,
          apiKeyId: values.apiKeyId,
          idempotencyKey,
          payloadHash: values.payloadHash,
          snapshot: values.snapshot,
          expiresAt: sql`now() + make_interval(secs => ${expiresInSeconds})`,
        })
        .onConflictDoNothing({ target: [quote.projectId, quote.environment, quote.idempotencyKey] })
        .returning({ id: quote.id, expiresAt: quote.expiresAt, snapshot: quote.snapshot });
      if (!created) return tx.rollback();

      return { ...created, externalCustomerId, isExpired: false };
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) return null;
    throw error;
  }
}
