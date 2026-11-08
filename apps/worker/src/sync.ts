import {
  claimOutboxRow,
  failAbandonedOutboxRows,
  loadProjection,
  readSyncGate,
  recordDelivered,
  recordDestinationOk,
  recordDestinationProblem,
  releaseOutboxRow,
  retryOutboxRow,
  type ClaimedOutboxRow,
} from "@billingrelay/db";
import { checkDestination, classifyDestinationError, deliver, type Destination } from "@billingrelay/sync-postgres";

// So one pass can't run for long. Whatever's left is still waiting in the outbox.
const MOST_PER_PASS = 25;

/** False when the destination itself failed, so the pass stops instead of trying every row against it. */
async function deliverOne(destination: Destination, claimed: ClaimedOutboxRow): Promise<boolean> {
  const projection = await loadProjection(claimed.entityType, claimed.entityId);
  if (!projection) {
    // Records are never deleted, so this would be a bug. It backs off and ends up visible as `failed`.
    await retryOutboxRow(claimed.id, "record_missing", null);
    return true;
  }

  const started = performance.now();
  try {
    const outcome = await deliver(destination, projection);
    const durationMs = Math.round(performance.now() - started);
    await recordDelivered(claimed, { sourceVersion: projection.row.sourceVersion, outcome, durationMs });
    console.log(`Sync ${claimed.entityType} ${claimed.entityId} v${projection.row.sourceVersion}: ${outcome}`);
    return true;
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    const failure = classifyDestinationError(error);
    if (failure.kind === "refused") {
      await retryOutboxRow(claimed.id, failure.code, durationMs);
      console.log(`Sync ${claimed.entityType} ${claimed.entityId}: refused (${failure.code}), retry later`);
      return true;
    }
    await releaseOutboxRow(claimed.id);
    await recordDestinationProblem({ state: failure.kind, code: failure.code });
    console.log(`Sync paused: destination ${failure.kind} (${failure.code})`);
    return false;
  }
}

/** Safe to run from any number of workers at once. Nothing here talks to PayPal. */
export async function runSyncPass(destination: Destination, shouldStop: () => boolean): Promise<void> {
  await failAbandonedOutboxRows();

  const gate = await readSyncGate();
  if (gate.state !== "ok") {
    if (!gate.due) return;
    const problem = await checkDestination(destination);
    if (problem) {
      const state = problem.kind === "down" ? "down" : "not_ready";
      await recordDestinationProblem({ state, code: problem.code });
      console.log(`Sync waiting: destination ${state} (${problem.code})`);
      return;
    }
    await recordDestinationOk();
    console.log("Sync: destination ready");
  }

  for (let done = 0; done < MOST_PER_PASS && !shouldStop(); done += 1) {
    const claimed = await claimOutboxRow();
    if (!claimed || !(await deliverOne(destination, claimed))) return;
  }
}
