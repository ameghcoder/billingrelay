import { sql } from "drizzle-orm";
import { getDb } from "./client";
import { retryDelay } from "./retry-delay";
import { paypalEvent, type ProjectScope } from "./schema";

const MAX_ATTEMPTS = 8;
// Longer than one event can take: each PayPal call stops at 10 seconds, and handling one makes at most a few.
const LEASE_SECONDS = 120;

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

export type ClaimedPaypalEvent = { id: string; eventType: string; payload: unknown; scope: ProjectScope };

/**
 * Takes one due event for the length of the lease and commits at once, so no lock is held during PayPal calls.
 * SKIP LOCKED: two workers never take the same row. A worker that dies just lets the lease run out.
 */
export async function claimPaypalEvent(): Promise<ClaimedPaypalEvent | null> {
  const { rows } = await getDb().execute<{ id: string; event_type: string; payload: unknown; project_id: string; environment: "sandbox" | "live" }>(sql`
    UPDATE paypal_event AS event
    SET attempts = event.attempts + 1,
        next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
    FROM paypal_connection AS connection
    WHERE connection.id = event.connection_id
      AND event.id = (
        SELECT id FROM paypal_event
        WHERE status = 'pending' AND next_attempt_at <= now() AND attempts < ${MAX_ATTEMPTS}
        ORDER BY next_attempt_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
    RETURNING event.id, event.event_type, event.payload, connection.project_id, connection.environment`);
  const row = rows[0];
  return row ? { id: row.id, eventType: row.event_type, payload: row.payload, scope: { projectId: row.project_id, environment: row.environment } } : null;
}

export async function finishPaypalEvent(id: string, status: "processed" | "ignored"): Promise<void> {
  await getDb().execute(sql`
    UPDATE paypal_event
    SET status = ${status}, failure_code = NULL, processed_at = now()
    WHERE id = ${id} AND status = 'pending'`);
}

/** Waits longer each time, then stays visible as `failed`. */
export async function retryPaypalEvent(id: string, failureCode: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE paypal_event
    SET failure_code = ${failureCode},
        status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
        next_attempt_at = now() + ${retryDelay(sql`attempts`)}
    WHERE id = ${id} AND status = 'pending'`);
}

/** A worker killed on an event's last attempt can't record that itself. */
export async function failAbandonedPaypalEvents(): Promise<void> {
  await getDb().execute(sql`
    UPDATE paypal_event
    SET status = 'failed', failure_code = COALESCE(failure_code, 'worker_died')
    WHERE status = 'pending' AND attempts >= ${MAX_ATTEMPTS} AND next_attempt_at <= now()`);
}
