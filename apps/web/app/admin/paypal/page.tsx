import { getDefaultProjectId } from "@billingrelay/db";
import { requireOperatorPage } from "@/lib/operator";
import { getSandboxConnection, toView } from "@/lib/paypal-connection";
import { ConnectionPanel } from "./connection-panel";

export default async function PaypalPage() {
  await requireOperatorPage();
  const projectId = await getDefaultProjectId();
  const connection = projectId ? await getSandboxConnection(projectId) : null;
  return (
    <>
      <h1 className="text-2xl font-semibold">PayPal</h1>
      <p className="mt-2 text-muted-foreground">Sandbox connection. Live payments are disabled in this project.</p>
      <ConnectionPanel initial={connection ? toView(connection) : null} />
    </>
  );
}
