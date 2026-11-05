import { savePaypalConnectionSchema } from "@billingrelay/core/paypal-connection";
import { isSecretsKeyValid } from "@billingrelay/core/secrets";
import { PaypalError } from "@billingrelay/provider-paypal";
import { saveConnection, toView } from "@/lib/paypal-connection";
import { apiError, jsonResponse, withSandbox } from "@/lib/paypal-routes";

export const PUT = withSandbox(async ({ request, projectId }) => {
  const body = savePaypalConnectionSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(400, "invalid_request", "Enter a client ID and a secret");
  if (!isSecretsKeyValid()) {
    return apiError(500, "secrets_key_invalid", "SECRETS_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  }

  try {
    return jsonResponse(toView(await saveConnection(projectId, body.data)));
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    console.warn(`PayPal rejected or missed a save: ${error.message}`);
    return error.kind === "rejected"
      ? apiError(422, "paypal_credentials_rejected", "PayPal rejected these credentials", { debugId: error.debugId })
      : apiError(503, "paypal_unreachable", "Couldn't reach PayPal. Nothing was saved. Try again.");
  }
});
