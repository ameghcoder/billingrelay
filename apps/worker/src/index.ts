import { closePools, recordWorkerHeartbeat, requireEnv } from "@billingrelay/db";
import { PgBoss } from "pg-boss";
import { runPass } from "./processing";

const HEARTBEAT_QUEUE = "worker-heartbeat";
const HEARTBEAT_INTERVAL_MS = 30_000;
const WAKE_QUEUE = "worker-wake";
const WAKE_INTERVAL_MS = 3_000;
// These jobs carry nothing: the rows hold the work, so there's no reason to keep them.
const WAKE_JOBS_KEPT_SECONDS = 3600;

// Refusing to start is easier to notice than every payment quietly failing to decrypt.
requireEnv("SECRETS_ENCRYPTION_KEY");

const boss = new PgBoss({ connectionString: requireEnv("DATABASE_URL") });
boss.on("error", (err) => console.error(`pg-boss error: ${err.message}`));

let stopping = false;
let passRunning = false;

await boss.start();
await boss.createQueue(HEARTBEAT_QUEUE);
await boss.work(HEARTBEAT_QUEUE, async () => {
  await recordWorkerHeartbeat();
});

await boss.createQueue(WAKE_QUEUE, { deleteAfterSeconds: WAKE_JOBS_KEPT_SECONDS });
await boss.work(WAKE_QUEUE, async () => {
  passRunning = true;
  try {
    await runPass(() => stopping);
  } catch (error) {
    // Only the name: the next wake tries again, and a query's error text could quote a buyer's details.
    console.error(`Pass failed: ${error instanceof Error ? error.name : "unknown"}`);
  } finally {
    passRunning = false;
  }
});

// Sent through the queue, not written directly, so a stuck queue also shows as stale.
const sendHeartbeat = () =>
  boss.send(HEARTBEAT_QUEUE, {}).catch((err: Error) => console.error(`heartbeat send failed: ${err.message}`));

// A lost wake costs nothing: the rows are still there for the next one.
const sendWake = () => {
  if (passRunning) return;
  boss.send(WAKE_QUEUE, {}).catch((err: Error) => console.error(`wake send failed: ${err.message}`));
};

await sendHeartbeat();
const heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
const wakeTimer = setInterval(sendWake, WAKE_INTERVAL_MS);
console.log("Worker started");

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, stopping worker`);
  clearInterval(heartbeatTimer);
  clearInterval(wakeTimer);
  await boss.stop({ graceful: true });
  await closePools();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
