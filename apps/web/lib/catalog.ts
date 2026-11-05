import {
  catalogConfigSchema,
  catalogVersionDetailSchema,
  catalogVersionSummarySchema,
  findKindChanges,
  toAttributeSchemas,
  toCatalogIssues,
  type CatalogConfig,
  type CatalogIssue,
  type CatalogVersionDetail,
  type CatalogVersionSummary,
} from "@billingrelay/core/catalog";
import type { CatalogScope, CatalogVersionRecord, CatalogVersionWithConfig } from "@billingrelay/db";
import { z } from "zod";

// Only sandbox can be used in this project, the same gate as the PayPal routes.
export const catalogScope = (projectId: string): CatalogScope => ({ projectId, environment: "sandbox" });

export const isVersionId = (id: string) => z.uuid().safeParse(id).success;

export const toSummary = (record: CatalogVersionRecord): CatalogVersionSummary =>
  catalogVersionSummarySchema.parse({ ...record, createdAt: record.createdAt.toISOString() });

export const toDetail = (record: CatalogVersionWithConfig): CatalogVersionDetail =>
  catalogVersionDetailSchema.parse({
    ...toSummary(record),
    config: record.config,
    attributeSchemas: toAttributeSchemas(record.config),
  });

/** Runs again at activation: the rules or the live version may have changed since this version was saved. */
export function checkForActivation(target: CatalogConfig, live: CatalogConfig | null): CatalogIssue[] {
  const parsed = catalogConfigSchema.safeParse(target);
  return parsed.success ? findKindChanges(parsed.data, live) : toCatalogIssues(parsed.error);
}
