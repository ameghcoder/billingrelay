import { configuredModel } from "@billingrelay/ai";
import { getDefaultProjectId, listCatalogVersions } from "@billingrelay/db";
import { sandboxScope } from "@/lib/admin-routes";
import { requireOperatorPage } from "@/lib/operator";
import { AiSetup } from "./ai-setup";

export default async function AiSetupPage() {
  await requireOperatorPage();
  const projectId = await getDefaultProjectId();
  if (!projectId) return <p className="text-muted-foreground">Run pnpm db:seed to create the project.</p>;
  const latest = (await listCatalogVersions(sandboxScope(projectId)))[0]?.version ?? 0;
  return (
    <>
      <h1 className="text-2xl font-semibold">AI setup</h1>
      <p className="mt-2 mb-6 text-muted-foreground">
        Describe what you sell. The AI drafts a catalog and checks it against every rule; it can&apos;t save, approve or make anything live. You
        save the draft as a version, then approve it and make it live in Catalog.
      </p>
      <AiSetup available={configuredModel() !== null} latestVersion={latest} />
    </>
  );
}
