import { apiKeySummarySchema, type ApiKeySummary } from "@billingrelay/core/api-keys";
import type { ApiKeyRecord } from "@billingrelay/db";

export const toApiKeySummary = (record: ApiKeyRecord): ApiKeySummary =>
  apiKeySummarySchema.parse({
    ...record,
    createdAt: record.createdAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
  });
