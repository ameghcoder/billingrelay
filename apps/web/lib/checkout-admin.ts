import { returnOriginSummarySchema, type ReturnOriginSummary } from "@billingrelay/core/checkouts";
import type { ReturnOriginRecord } from "@billingrelay/db";

export const toReturnOriginSummary = (record: ReturnOriginRecord): ReturnOriginSummary =>
  returnOriginSummarySchema.parse({ id: record.id, origin: record.origin, createdAt: record.createdAt.toISOString() });
