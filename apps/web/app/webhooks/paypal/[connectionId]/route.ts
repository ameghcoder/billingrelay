import { openStoredSession } from "@billingrelay/billing";
import { SecretUnreadableError } from "@billingrelay/core/secrets";
import { getPaypalConnectionById, storePaypalEvent } from "@billingrelay/db";
import { hasSignatureHeaders, PaypalError, verifyEvent } from "@billingrelay/provider-paypal";
import { z } from "zod";
import { apiError, isUuid, jsonResponse, readBodyUpTo } from "@/lib/api-response";

const MAX_BODY_BYTES = 256 * 1024;

const eventSchema = z.looseObject({ id: z.string().min(1), event_type: z.string().min(1) });

const parseEvent = (rawBody: string) => {
  try {
    return eventSchema.safeParse(JSON.parse(rawBody));
  } catch {
    return null;
  }
};

const notVerified = () => apiError(400, "not_verified", "This event could not be verified");
// A 5xx makes PayPal send the event again later.
const tryAgainLater = () => apiError(503, "try_again_later", "This event could not be checked right now");

/** Verify, store, acknowledge, in that order. No billing logic happens in this request. */
export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }): Promise<Response> {
  try {
    const { connectionId } = await context.params;
    const connection = isUuid(connectionId) ? await getPaypalConnectionById(connectionId) : null;
    if (!connection?.webhookId || connection.environment !== "sandbox") return apiError(404, "not_found", "No such webhook");

    const rawBody = await readBodyUpTo(request, MAX_BODY_BYTES);
    if (rawBody === null) return apiError(413, "request_too_large", "The event is too large");

    const event = parseEvent(rawBody);
    if (!event?.success || !hasSignatureHeaders(request.headers)) return notVerified();

    const session = await openStoredSession(connection);
    const verified = await verifyEvent(session, connection.webhookId, request.headers, rawBody);
    if (!verified) {
      // Nothing from the event: it's unverified, so anyone could write lines into the log with it.
      console.warn("PayPal event refused");
      return notVerified();
    }

    await storePaypalEvent({ connectionId, eventId: event.data.id, eventType: event.data.event_type, rawBody });
    return jsonResponse({ received: true });
  } catch (error) {
    if (error instanceof PaypalError || error instanceof SecretUnreadableError) {
      console.warn(`PayPal event check failed: ${error.message}`);
      return tryAgainLater();
    }
    console.error(`Webhook route failed: ${error instanceof Error ? error.name : "unknown"}`);
    return apiError(500, "internal_error", "Something went wrong");
  }
}
