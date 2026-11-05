import { getCatalogVersion, getDefaultProjectId, listCatalogVersions } from "@billingrelay/db";
import { catalogScope, toDetail, toSummary } from "@/lib/catalog";
import { requireOperatorPage } from "@/lib/operator";
import { CatalogView } from "./catalog-view";

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ version?: string }> }) {
  await requireOperatorPage();
  const projectId = await getDefaultProjectId();
  if (!projectId) return <p className="text-muted-foreground">Run pnpm db:seed to create the project.</p>;

  const scope = catalogScope(projectId);
  const versions = await listCatalogVersions(scope);
  const { version: requested } = await searchParams;
  const selected = versions.find((candidate) => String(candidate.version) === requested) ?? versions[0];
  const detail = selected ? await getCatalogVersion(scope, selected.id) : null;

  return <CatalogView versions={versions.map(toSummary)} selected={detail ? toDetail(detail) : null} />;
}
