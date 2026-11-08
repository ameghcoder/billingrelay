import { openStoredSession, secretBinding } from "@billingrelay/billing";
import {
  paypalConnectionViewSchema,
  type PaypalCheckResult,
  type PaypalConnectionView,
  type PaypalWebhookError,
  type SavePaypalConnection,
} from "@billingrelay/core/paypal-connection";
import { encryptSecret, SecretUnreadableError } from "@billingrelay/core/secrets";
import {
  getPaypalConnection,
  savePaypalCredentials,
  updatePaypalConnectionStatus,
  type PaypalConnectionRecord,
} from "@billingrelay/db";
import {
  ensureWebhook,
  findWebhook,
  hasOurEvents,
  openSession,
  PaypalError,
  readCapabilities,
  type PaypalSession,
} from "@billingrelay/provider-paypal";

// From config, never the request's Host header: a forged header could send PayPal's events, or a buyer, elsewhere.
export function publicOrigin(): string | null {
  try {
    const url = new URL(process.env.PUBLIC_BASE_URL ?? "");
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function webhookUrl(connectionId: string): string | null {
  const origin = publicOrigin();
  return origin && `${origin}/webhooks/paypal/${connectionId}`;
}

export function toView(connection: PaypalConnectionRecord): PaypalConnectionView {
  return paypalConnectionViewSchema.parse({
    environment: connection.environment,
    clientId: `••••${connection.clientId.slice(-4)}`,
    secretStored: true,
    webhook: {
      status: connection.webhookStatus,
      url: webhookUrl(connection.id),
      error: connection.webhookError,
    },
    capabilities: connection.capabilities,
    lastCheck: connection.lastCheck,
    lastCheckedAt: connection.lastCheckedAt?.toISOString() ?? null,
  });
}

function keepWebhookState(connection: PaypalConnectionRecord) {
  return {
    webhookId: connection.webhookId,
    webhookStatus: connection.webhookStatus,
    webhookError: connection.webhookError,
    capabilities: connection.capabilities,
  };
}

function sessionFailure(error: unknown): PaypalCheckResult {
  if (error instanceof SecretUnreadableError) return "secret_unreadable";
  if (error instanceof PaypalError) return error.kind === "rejected" ? "credentials_rejected" : "paypal_unreachable";
  throw error;
}

async function registerWebhook(session: PaypalSession, url: string | null): Promise<PaypalWebhookError | null> {
  if (!url) return "public_url_invalid";
  try {
    await ensureWebhook(session, url);
    return null;
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    console.warn(`PayPal webhook setup failed: ${error.message}`);
    return error.kind === "rejected" ? "webhook_rejected" : "paypal_unreachable";
  }
}

/** Read-only unless `setUpWebhook` is set. Each result is saved, so the page shows what was last seen. */
export async function checkConnection(
  connection: PaypalConnectionRecord,
  { setUpWebhook }: { setUpWebhook: boolean },
): Promise<PaypalConnectionRecord> {
  let session: PaypalSession;
  try {
    session = await openStoredSession(connection, { fresh: true });
  } catch (error) {
    return updatePaypalConnectionStatus(connection.id, {
      ...keepWebhookState(connection),
      lastCheck: sessionFailure(error),
    });
  }

  const url = webhookUrl(connection.id);
  const setupError = setUpWebhook ? await registerWebhook(session, url) : null;
  const capabilities = readCapabilities(session.scopes);

  try {
    const webhook = url ? await findWebhook(session, url) : undefined;
    const registered = webhook !== undefined && hasOurEvents(webhook);
    const hasEveryCapability = Object.values(capabilities).every(Boolean);
    return await updatePaypalConnectionStatus(connection.id, {
      webhookId: webhook?.id ?? null,
      webhookStatus: registered ? "registered" : "not_registered",
      webhookError: registered ? null : (setupError ?? connection.webhookError ?? "webhook_missing"),
      capabilities,
      lastCheck: !registered ? "webhook_missing" : hasEveryCapability ? "ok" : "capability_missing",
    });
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    console.warn(`PayPal check failed: ${error.message}`);
    return updatePaypalConnectionStatus(connection.id, {
      ...keepWebhookState(connection),
      capabilities,
      webhookError: setupError ?? connection.webhookError,
      // A token that can't read webhooks is missing that permission; it isn't a bad secret.
      lastCheck: error.kind === "rejected" ? "capability_missing" : "paypal_unreachable",
    });
  }
}

/**
 * The credentials are proven with PayPal first, so a failure here leaves an existing connection
 * untouched. No database transaction is open during any PayPal call.
 */
export async function saveConnection(
  projectId: string,
  { clientId, clientSecret }: SavePaypalConnection,
): Promise<PaypalConnectionRecord> {
  await openSession({ environment: "sandbox", clientId, clientSecret });
  const connection = await savePaypalCredentials({
    projectId,
    environment: "sandbox",
    clientId,
    secretEncrypted: encryptSecret(clientSecret, secretBinding(projectId, "sandbox")),
  });
  return checkConnection(connection, { setUpWebhook: true });
}

export const getSandboxConnection = (projectId: string) => getPaypalConnection(projectId, "sandbox");
