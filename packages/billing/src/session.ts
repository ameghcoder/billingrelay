import { decryptSecret, SecretUnreadableError } from "@billingrelay/core/secrets";
import { getPaypalConnection, getPaypalConnectionSecret, type PaypalConnectionRecord } from "@billingrelay/db";
import { openReusedSession, openSession, PaypalError, type PaypalSession } from "@billingrelay/provider-paypal";

export const secretBinding = (projectId: string, environment: string) => `paypal_connection:${projectId}:${environment}`;

/** Reuses a recent token unless `fresh` is set, which a connection check needs to really ask PayPal. */
export async function openStoredSession(connection: PaypalConnectionRecord, { fresh = false } = {}): Promise<PaypalSession> {
  const secretEncrypted = await getPaypalConnectionSecret(connection.id);
  if (!secretEncrypted) throw new SecretUnreadableError();
  const credentials = {
    environment: connection.environment,
    clientId: connection.clientId,
    clientSecret: decryptSecret(secretEncrypted, secretBinding(connection.projectId, connection.environment)),
  };
  return fresh ? openSession(credentials) : openReusedSession(credentials);
}

/** The project's sandbox session. Every payment and subscription call comes through here, so no path can reach live while it's switched off. */
export async function sessionFor(scope: { projectId: string; environment: "sandbox" | "live" }): Promise<PaypalSession> {
  if (scope.environment !== "sandbox") throw new PaypalError("unavailable", "live_disabled");
  const connection = await getPaypalConnection(scope.projectId, scope.environment);
  if (!connection) throw new PaypalError("unavailable", "not_connected");
  try {
    return await openStoredSession(connection);
  } catch (error) {
    if (error instanceof SecretUnreadableError) throw new PaypalError("unavailable", "secret_unreadable");
    throw error;
  }
}

