import { buildFlow } from "@billingrelay/core/flow";
import { getActiveCatalog, getCatalogVersion, getDefaultProjectId, getDestinationState, getProductActivity, listCatalogVersions } from "@billingrelay/db";
import Link from "next/link";
import { sandboxScope } from "@/lib/admin-routes";
import { requireOperatorPage } from "@/lib/operator";
import { FlowCanvas } from "./flow-canvas";

export default async function FlowPage({ searchParams }: { searchParams: Promise<{ version?: string }> }) {
  await requireOperatorPage();
  const projectId = await getDefaultProjectId();
  if (!projectId) return <p className="text-muted-foreground">Run pnpm db:seed to create the project.</p>;
  const scope = sandboxScope(projectId);
  const versions = await listCatalogVersions(scope);
  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground">
        Nothing to draw yet. Add a product in <Link className="underline" href="/admin/catalog">Catalog</Link> or{" "}
        <Link className="underline" href="/admin/ai">AI setup</Link>.
      </p>
    );
  }
  const wanted = Number((await searchParams).version);
  const live = await getActiveCatalog(scope);
  const summary = versions.find((version) => version.version === wanted) ?? versions.find((version) => version.id === live?.id) ?? versions[0]!;
  const version = (await getCatalogVersion(scope, summary.id))!;
  const flow = buildFlow(version.config, { syncConfigured: (await getDestinationState()) !== "not_configured", activity: await getProductActivity(scope) });

  return (
    <>
      <h1 className="text-2xl font-semibold">Flow</h1>
      <p className="mt-2 mb-4 text-muted-foreground">
        Generated from version {version.version}: what a purchase of each product goes through. Click a step for its settings. An edit saves a new
        version, which needs its own approval before it can go live.
      </p>
      <FlowCanvas
        flow={flow}
        version={{ id: version.id, version: version.version, isLive: version.isLive, approved: version.approved, isLatest: versions[0]!.id === version.id }}
        versions={versions.map((item) => ({ version: item.version, isLive: item.isLive }))}
      />
    </>
  );
}
