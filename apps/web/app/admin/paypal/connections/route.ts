import { getSandboxConnection, toView } from "@/lib/paypal-connection";
import { jsonResponse, withProject } from "@/lib/paypal-routes";

export const GET = withProject(async ({ projectId }) => {
  const connection = await getSandboxConnection(projectId);
  return jsonResponse({ connections: connection ? [toView(connection)] : [] });
});
