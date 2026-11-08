import { closePools, recordWorkerHeartbeat, requireEnv, startSyncStatus } from "@billingrelay/db";
import { closeDestination, openDestination, type Destination } from "@billingrelay/sync-postgres";
import { PgBoss } from "pg-boss";
import { runPass } from "./processing";
import { runSyncPass } from "./sync";

const HEARTBEAT_QUEUE = "worker-heartbeat";
const HEARTBEAT_INTERVAL_MS = 30_000;
const WAKE_QUEUE = "worker-wake";
// Its own queue, so a slow or hanging merchant database can't hold up payments.
const SYNC_WAKE_QUEUE = "sync-wake";
const WAKE_INTERVAL_MS = 3_000;
// These jobs carry nothing: the rows hold the work, so there's no reason to keep them.
const WAKE_JOBS_KEPT_SECONDS = 3600;

// Refusing to start is easier to notice than every payment quietly failing to decrypt.
requireEnv("SECRETS_ENCRYPTION_KEY");

const boss = new PgBoss({ connectionString: requireEnv("DATABASE_URL") });
boss.on("error", (err) => console.error(`pg-boss error: ${err.message}`));

let stopping = false;

// A lost wake costs nothing: the rows are still there for the next one.
function wakeLoop(queue: string, pass: (shouldStop: () => boolean) => Promise<void>) {
  let running = false;
  const handler = async () => {
    running = true;
    try {
      await pass(() => stopping);
    } catch (error) {
      // Only the name: the next wake tries again, and a query's error text could quote a buyer's details.
      console.error(`${queue} pass failed: ${error instanceof Error ? error.name : "unknown"}`);
    } finally {
      running = false;
    }
  };
  const send = () => {
    if (running) return;
    boss.send(queue, {}).catch((err: Error) => console.error(`${queue} send failed: ${err.message}`));
  };
  return { handler, send };
}

await boss.start();
await boss.createQueue(HEARTBEAT_QUEUE);
await boss.work(HEARTBEAT_QUEUE, async () => {
  await recordWorkerHeartbeat();
});

const processing = wakeLoop(WAKE_QUEUE, runPass);
await boss.createQueue(WAKE_QUEUE, { deleteAfterSeconds: WAKE_JOBS_KEPT_SECONDS });
await boss.work(WAKE_QUEUE, processing.handler);

// Sync is optional. Only the worker holds the destination's login; the web app reads its state from our own database.
async function startSync(): Promise<Destination | null> {
  const opened = openDestination(process.env.DESTINATION_DATABASE_URL);
  if (opened === null) {
    await startSyncStatus({ state: "not_configured" });
    return null;
  }
  if ("problem" in opened) {
    await startSyncStatus({ state: "not_ready", code: opened.problem });
    console.error(`DESTINATION_DATABASE_URL refused: ${opened.problem}. Sync is off.`);
    return null;
  }
  await startSyncStatus({ state: "checking" });
  return opened;
}
const destination = await startSync();

const sync = destination ? wakeLoop(SYNC_WAKE_QUEUE, (shouldStop) => runSyncPass(destination, shouldStop)) : null;
if (sync) {
  await boss.createQueue(SYNC_WAKE_QUEUE, { deleteAfterSeconds: WAKE_JOBS_KEPT_SECONDS });
  await boss.work(SYNC_WAKE_QUEUE, sync.handler);
}

// Sent through the queue, not written directly, so a stuck queue also shows as stale.
const sendHeartbeat = () =>
  boss.send(HEARTBEAT_QUEUE, {}).catch((err: Error) => console.error(`heartbeat send failed: ${err.message}`));

await sendHeartbeat();
const heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
const wakeTimer = setInterval(() => {
  processing.send();
  sync?.send();
}, WAKE_INTERVAL_MS);
console.log(`Worker started, sync ${destination ? "on" : "off"}`);

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, stopping worker`);
  clearInterval(heartbeatTimer);
  clearInterval(wakeTimer);
  await boss.stop({ graceful: true });
  if (destination) await closeDestination(destination);
  await closePools();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
