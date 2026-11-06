import { sql } from "drizzle-orm";
import { getDb } from "./client";
import { paypalEvent } from "./schema";

/** The body goes in as received. The same event from PayPal again changes nothing. */
export async function storePaypalEvent(values: { connectionId: string; eventId: string; eventType: string; rawBody: string }): Promise<void> {
  await getDb()
    .insert(paypalEvent)
    .values({
      connectionId: values.connectionId,
      eventId: values.eventId,
      eventType: values.eventType,
      payload: sql`${values.rawBody}::json`,
    })
    .onConflictDoNothing({ target: [paypalEvent.connectionId, paypalEvent.eventId] });
}
