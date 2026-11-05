import { getDefaultProjectId, listApiKeys } from "@billingrelay/db";
import { sandboxScope } from "@/lib/admin-routes";
import { toApiKeySummary } from "@/lib/api-keys";
import { requireOperatorPage } from "@/lib/operator";
import { KeysPanel } from "./keys-panel";

export default async function DevelopersPage() {
  await requireOperatorPage();
  const projectId = await getDefaultProjectId();
  if (!projectId) return <p className="text-muted-foreground">Run pnpm db:seed to create the project.</p>;

  const keys = await listApiKeys(sandboxScope(projectId));
  return <KeysPanel keys={keys.map(toApiKeySummary)} />;
}
