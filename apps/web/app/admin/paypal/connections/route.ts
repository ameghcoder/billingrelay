import { jsonResponse, withProject } from "@/lib/admin-routes";
import { getSandboxConnection, toView } from "@/lib/paypal-connection";

export const GET = withProject(async ({ projectId }) => {
  const connection = await getSandboxConnection(projectId);
  return jsonResponse({ connections: connection ? [toView(connection)] : [] });
});
