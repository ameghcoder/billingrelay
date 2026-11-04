import { closePools, recordWorkerHeartbeat, requireEnv } from "@billingrelay/db";
import { PgBoss } from "pg-boss";

const HEARTBEAT_QUEUE = "worker-heartbeat";
const HEARTBEAT_INTERVAL_MS = 30_000;

const boss = new PgBoss({ connectionString: requireEnv("DATABASE_URL") });
boss.on("error", (err) => console.error(`pg-boss error: ${err.message}`));

await boss.start();
await boss.createQueue(HEARTBEAT_QUEUE);
await boss.work(HEARTBEAT_QUEUE, async () => {
  await recordWorkerHeartbeat();
});

// Sent through the queue, not written directly, so a stuck queue also shows as stale.
const sendHeartbeat = () =>
  boss.send(HEARTBEAT_QUEUE, {}).catch((err: Error) => console.error(`heartbeat send failed: ${err.message}`));

await sendHeartbeat();
const timer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
console.log("Worker started");

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, stopping worker`);
  clearInterval(timer);
  await boss.stop({ graceful: true });
  await closePools();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
