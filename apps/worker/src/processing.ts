import { handleEvent, recheckPayment, type EventOutcome } from "@billingrelay/billing";
import {
  applyCheckoutBenefits,
  claimCheckoutForBenefits,
  claimPaypalEvent,
  claimUnclearCheckout,
  failAbandonedPaypalEvents,
  finishPaypalEvent,
  retryPaypalEvent,
  type ClaimedPaypalEvent,
} from "@billingrelay/db";
import { PaypalError } from "@billingrelay/provider-paypal";

// So one pass can't run for long. Whatever's left is still in its row, for the next pass.
const MOST_PER_PASS = 25;

/** Only safe fields: an error from a query or a payload could quote a buyer's details. */
const describe = (error: unknown) => (error instanceof PaypalError ? error.message : error instanceof Error ? error.name : "unknown");

async function runEvent(event: ClaimedPaypalEvent): Promise<void> {
  let outcome: EventOutcome;
  try {
    outcome = await handleEvent(event);
  } catch (error) {
    console.error(`Event ${event.id} failed: ${describe(error)}`);
    outcome = { status: "retry", code: error instanceof PaypalError ? "paypal_unavailable" : "internal_error" };
  }
  if (outcome.status === "retry") {
    await retryPaypalEvent(event.id, outcome.code);
    console.log(`Event ${event.id} ${event.eventType}: retry later (${outcome.code})`);
    return;
  }
  await finishPaypalEvent(event.id, outcome.status);
  console.log(`Event ${event.id} ${event.eventType}: ${outcome.status}`);
}

/** The claim already moved the checkout's next look back, so a failure here just waits for that. */
async function runCheckout(label: string, checkoutId: string, work: (id: string) => Promise<void>): Promise<void> {
  try {
    await work(checkoutId);
    console.log(`Checkout ${checkoutId}: ${label} checked`);
  } catch (error) {
    console.error(`Checkout ${checkoutId}: ${label} failed: ${describe(error)}`);
  }
}

async function drain<T>(shouldStop: () => boolean, claim: () => Promise<T | null>, work: (item: T) => Promise<void>): Promise<void> {
  for (let done = 0; done < MOST_PER_PASS && !shouldStop(); done += 1) {
    const item = await claim();
    if (item === null) return;
    await work(item);
  }
}

/** One look at everything that's due. Safe to run from any number of workers at once. */
export async function runPass(shouldStop: () => boolean): Promise<void> {
  await failAbandonedPaypalEvents();
  await drain(shouldStop, claimPaypalEvent, runEvent);
  await drain(shouldStop, claimCheckoutForBenefits, (id) => runCheckout("benefits", id, applyCheckoutBenefits));
  await drain(shouldStop, claimUnclearCheckout, (id) => runCheckout("unclear payment", id, recheckPayment));
}
