import { quoteResponseSchema, type QuoteResponse } from "@billingrelay/core/quotes";
import type { QuoteRecord } from "@billingrelay/db";

export const toQuoteResponse = (record: QuoteRecord): QuoteResponse =>
  quoteResponseSchema.parse({
    id: record.id,
    externalCustomerId: record.externalCustomerId,
    status: record.isExpired ? "expired" : "open",
    expiresAt: record.expiresAt.toISOString(),
    snapshot: record.snapshot,
  });
