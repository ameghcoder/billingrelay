import type { CatalogBenefit } from "@billingrelay/core/catalog";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { getDb } from "./client";
import { grantCredits, restrictCreditsFrom } from "./credits";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

const addOutboxRow = (tx: Tx, row: { projectId: string; entityType: "checkout" | "access_grant"; entityId: string; sourceVersion: number }) =>
  tx.execute(sql`
    INSERT INTO outbox (id, project_id, entity_type, entity_id, source_version)
    VALUES (${uuidv7()}, ${row.projectId}, ${row.entityType}, ${row.entityId}, ${row.sourceVersion})`);

type PaidCheckout = {
  project_id: string;
  environment: string;
  customer_id: string;
  paypal_capture_id: string;
  snapshot: { quantity: number; benefits: CatalogBenefit[] };
};

async function grantAccess(tx: Tx, checkoutId: string, paid: PaidCheckout, accessKey: string): Promise<void> {
  // Only a newly inserted effect changes anything, however many signals arrive for this capture.
  const effect = await tx.execute(sql`
    INSERT INTO billing_effect (id, project_id, checkout_id, paypal_payment_id, kind)
    VALUES (${uuidv7()}, ${paid.project_id}, ${checkoutId}, ${paid.paypal_capture_id}, 'access')
    ON CONFLICT (paypal_payment_id, kind) DO NOTHING
    RETURNING id`);
  if (effect.rows.length === 0) return;

  const grantId = uuidv7();
  await tx.execute(sql`
    INSERT INTO access_grant (id, project_id, environment, customer_id, access_key, checkout_id, paypal_payment_id)
    VALUES (${grantId}, ${paid.project_id}, ${paid.environment}, ${paid.customer_id}, ${accessKey}, ${checkoutId}, ${paid.paypal_capture_id})`);
  await addOutboxRow(tx, { projectId: paid.project_id, entityType: "access_grant", entityId: grantId, sourceVersion: 1 });
}

/**
 * Applies what the snapshot says, once, in one transaction with the status and outbox rows. The row lock means this and a
 * refund happen one after the other, and the WHERE means a refund that came first stops this. A subscription's benefits come
 * from its payments instead (`recordSubscriptionState`). Packs paid before the ledger existed wait as `waiting_for_credit_ledger`.
 */
export async function applyCheckoutBenefits(id: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const { rows } = await tx.execute<PaidCheckout>(sql`
      SELECT project_id, environment, customer_id, paypal_capture_id, snapshot
      FROM checkout
      WHERE id = ${id} AND money_status = 'captured' AND fulfillment_status = 'pending'
        AND (fulfillment_reason IS NULL OR fulfillment_reason = 'waiting_for_credit_ledger')
        AND snapshot->'product'->>'kind' <> 'subscription'
      FOR UPDATE`);
    const paid = rows[0];
    if (!paid) return;

    for (const benefit of paid.snapshot.benefits) {
      if (benefit.kind === "access") await grantAccess(tx, id, paid, benefit.key);
      // Per unit in the snapshot, so 2 packs of 5,000 grant 10,000. One grant per capture, however often this runs.
      if (benefit.kind === "credits") {
        await grantCredits(tx, {
          projectId: paid.project_id,
          environment: paid.environment,
          customerId: paid.customer_id,
          paypalPaymentId: paid.paypal_capture_id,
          bucket: "pack",
          amount: benefit.amount * paid.snapshot.quantity,
          expiresAt: null,
          checkoutId: id,
          subscriptionId: null,
        });
      }
    }

    const { rows: applied } = await tx.execute<{ source_version: number }>(sql`
      UPDATE checkout
      SET fulfillment_status = 'applied', fulfillment_reason = NULL, source_version = source_version + 1, updated_at = now()
      WHERE id = ${id}
      RETURNING source_version`);
    await addOutboxRow(tx, { projectId: paid.project_id, entityType: "checkout", entityId: id, sourceVersion: applied[0]!.source_version });
  });
}

/**
 * The one move out of `captured`: a refund of this exact capture. Full or partial, it goes to a person,
 * and access stops. False when nothing changed, such as a second refund of the same capture.
 */
export async function restrictRefundedCheckout(id: string, captureId: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const { rows } = await tx.execute<{ project_id: string; source_version: number }>(sql`
      UPDATE checkout
      SET money_status = 'refund_review',
          fulfillment_status = 'restricted',
          fulfillment_reason = NULL,
          source_version = source_version + 1,
          updated_at = now()
      WHERE id = ${id} AND money_status = 'captured' AND paypal_capture_id = ${captureId}
      RETURNING project_id, source_version`);
    const changed = rows[0];
    if (!changed) return false;
    await addOutboxRow(tx, { projectId: changed.project_id, entityType: "checkout", entityId: id, sourceVersion: changed.source_version });

    const { rows: grants } = await tx.execute<{ id: string; source_version: number }>(sql`
      UPDATE access_grant
      SET status = 'restricted', source_version = source_version + 1, updated_at = now()
      WHERE checkout_id = ${id} AND status = 'active'
      RETURNING id, source_version`);
    for (const grant of grants) {
      await addOutboxRow(tx, { projectId: changed.project_id, entityType: "access_grant", entityId: grant.id, sourceVersion: grant.source_version });
    }
    await restrictCreditsFrom(tx, id);
    return true;
  });
}
