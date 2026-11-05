import {
  catalogConfigSchema,
  catalogVersionDetailSchema,
  catalogVersionSummarySchema,
  findKindChanges,
  toAttributeSchemas,
  toFieldIssues,
  type CatalogConfig,
  type FieldIssue,
  type CatalogVersionDetail,
  type CatalogVersionSummary,
} from "@billingrelay/core/catalog";
import type { CatalogVersionRecord, CatalogVersionWithConfig } from "@billingrelay/db";

export const toSummary = (record: CatalogVersionRecord): CatalogVersionSummary =>
  catalogVersionSummarySchema.parse({ ...record, createdAt: record.createdAt.toISOString() });

export const toDetail = (record: CatalogVersionWithConfig): CatalogVersionDetail =>
  catalogVersionDetailSchema.parse({
    ...toSummary(record),
    config: record.config,
    attributeSchemas: toAttributeSchemas(record.config),
  });

/** Runs again at activation: the rules or the live version may have changed since this version was saved. */
export function checkForActivation(target: CatalogConfig, live: CatalogConfig | null): FieldIssue[] {
  const parsed = catalogConfigSchema.safeParse(target);
  return parsed.success ? findKindChanges(parsed.data, live) : toFieldIssues(parsed.error);
}
