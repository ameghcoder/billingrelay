import type { CatalogConfig, FieldIssue } from "@billingrelay/core/catalog";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { getDb } from "./client";
import { catalogActive, catalogVersion, type ProjectScope } from "./schema";

const summaryColumns = {
  id: catalogVersion.id,
  version: catalogVersion.version,
  isLive: sql<boolean>`${catalogActive.versionId} IS NOT NULL`,
  productCount: sql<number>`json_array_length(${catalogVersion.config} -> 'products')`,
  createdAt: catalogVersion.createdAt,
};

export type CatalogVersionRecord = { id: string; version: number; isLive: boolean; productCount: number; createdAt: Date };
export type CatalogVersionWithConfig = CatalogVersionRecord & { config: CatalogConfig };
export type ActiveCatalog = { id: string; version: number; config: CatalogConfig };

const inScope = ({ projectId, environment }: ProjectScope) =>
  and(eq(catalogVersion.projectId, projectId), eq(catalogVersion.environment, environment));

const selectVersions = <Columns extends typeof summaryColumns>(columns: Columns) =>
  getDb().select(columns).from(catalogVersion).leftJoin(catalogActive, eq(catalogActive.versionId, catalogVersion.id));

export async function listCatalogVersions(scope: ProjectScope): Promise<CatalogVersionRecord[]> {
  return selectVersions(summaryColumns).where(inScope(scope)).orderBy(desc(catalogVersion.version));
}

/** Any version in this project and environment, for the operator. Checkout code uses getActiveCatalog. */
export async function getCatalogVersion(scope: ProjectScope, id: string): Promise<CatalogVersionWithConfig | null> {
  const [row] = await selectVersions({ ...summaryColumns, config: catalogVersion.config })
    .where(and(inScope(scope), eq(catalogVersion.id, id)));
  return row ?? null;
}

/** The only version checkout may read. A saved draft never comes back from here. */
export async function getActiveCatalog(scope: ProjectScope): Promise<ActiveCatalog | null> {
  const [row] = await getDb()
    .select({ id: catalogVersion.id, version: catalogVersion.version, config: catalogVersion.config })
    .from(catalogActive)
    .innerJoin(catalogVersion, eq(catalogVersion.id, catalogActive.versionId))
    .where(and(eq(catalogActive.projectId, scope.projectId), eq(catalogActive.environment, scope.environment)));
  return row ?? null;
}

export type SaveCatalogResult =
  | { status: "saved"; id: string; version: number }
  | { status: "conflict"; latestVersion: number };

const latestVersion = async (scope: ProjectScope) => {
  const [row] = await getDb().select({ latest: max(catalogVersion.version) }).from(catalogVersion).where(inScope(scope));
  return row?.latest ?? 0;
};

/** The unique constraint decides concurrent saves: exactly one gets `baseVersion + 1`, the rest conflict. */
export async function saveCatalogVersion(
  values: ProjectScope & { baseVersion: number; config: CatalogConfig; createdBy: string },
): Promise<SaveCatalogResult> {
  const latest = await latestVersion(values);
  if (latest !== values.baseVersion) return { status: "conflict", latestVersion: latest };

  const [row] = await getDb()
    .insert(catalogVersion)
    .values({
      projectId: values.projectId,
      environment: values.environment,
      version: values.baseVersion + 1,
      config: values.config,
      createdBy: values.createdBy,
    })
    .onConflictDoNothing({ target: [catalogVersion.projectId, catalogVersion.environment, catalogVersion.version] })
    .returning({ id: catalogVersion.id, version: catalogVersion.version });

  return row ? { status: "saved", ...row } : { status: "conflict", latestVersion: await latestVersion(values) };
}

export type ActivateCatalogResult =
  | { status: "activated"; version: number }
  | { status: "not_found" }
  | { status: "rejected"; issues: FieldIssue[] };

/** `check` runs while the live row is locked, so it can't pass against a version that's being replaced. */
export async function activateCatalogVersion(
  values: ProjectScope & {
    versionId: string;
    activatedBy: string;
    check: (target: CatalogConfig, live: CatalogConfig | null) => FieldIssue[];
  },
): Promise<ActivateCatalogResult> {
  return getDb().transaction(async (tx) => {
    const [target] = await tx
      .select({ version: catalogVersion.version, config: catalogVersion.config })
      .from(catalogVersion)
      .where(and(inScope(values), eq(catalogVersion.id, values.versionId)));
    if (!target) return { status: "not_found" };

    const [live] = await tx
      .select({ versionId: catalogActive.versionId, config: catalogVersion.config })
      .from(catalogActive)
      .innerJoin(catalogVersion, eq(catalogVersion.id, catalogActive.versionId))
      .where(and(eq(catalogActive.projectId, values.projectId), eq(catalogActive.environment, values.environment)))
      .for("update", { of: catalogActive });
    if (live?.versionId === values.versionId) return { status: "activated", version: target.version };

    const issues = values.check(target.config, live?.config ?? null);
    if (issues.length > 0) return { status: "rejected", issues };

    await tx
      .insert(catalogActive)
      .values({
        projectId: values.projectId,
        environment: values.environment,
        versionId: values.versionId,
        activatedBy: values.activatedBy,
      })
      .onConflictDoUpdate({
        target: [catalogActive.projectId, catalogActive.environment],
        set: { versionId: values.versionId, activatedAt: sql`now()`, activatedBy: values.activatedBy },
      });
    return { status: "activated", version: target.version };
  });
}
