import { getDefaultProjectId, listApiKeys, listReturnOrigins } from "@billingrelay/db";
import { sandboxScope } from "@/lib/admin-routes";
import { toApiKeySummary } from "@/lib/api-keys";
import { toReturnOriginSummary } from "@/lib/checkout-admin";
import { requireOperatorPage } from "@/lib/operator";
import { KeysPanel } from "./keys-panel";
import { ReturnOriginsPanel } from "./return-origins-panel";

export default async function DevelopersPage() {
  await requireOperatorPage();
  const projectId = await getDefaultProjectId();
  if (!projectId) return <p className="text-muted-foreground">Run pnpm db:seed to create the project.</p>;

  const scope = sandboxScope(projectId);
  const [keys, origins] = await Promise.all([listApiKeys(scope), listReturnOrigins(scope)]);
  return (
    <>
      <KeysPanel keys={keys.map(toApiKeySummary)} />
      <ReturnOriginsPanel origins={origins.map(toReturnOriginSummary)} />
    </>
  );
}
