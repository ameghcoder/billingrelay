import { apiError, jsonResponse } from "@/lib/admin-routes";
import { checkConnection, getSandboxConnection, toView } from "@/lib/paypal-connection";
import { withSandbox } from "@/lib/paypal-routes";

export const POST = withSandbox(async ({ projectId }) => {
  const connection = await getSandboxConnection(projectId);
  if (!connection) return apiError(404, "not_connected", "Save your PayPal credentials first");
  return jsonResponse(toView(await checkConnection(connection, { setUpWebhook: false })));
});
