import { getSourcePool } from "./client";

export type DbStatus = "ok" | "down";
export type WorkerStatus = "ok" | "stale";

const WORKER_STALE_AFTER_SECONDS = 90;

export async function pingSource(): Promise<DbStatus> {
  try {
    await getSourcePool().query("SELECT 1");
    return "ok";
  } catch {
    return "down";
  }
}

export async function getWorkerStatus(): Promise<WorkerStatus> {
  try {
    // Age is computed in the database so app and DB clock drift can't affect it.
    const { rows } = await getSourcePool().query<{ fresh: boolean }>(
      "SELECT last_beat_at > now() - make_interval(secs => $1) AS fresh FROM worker_heartbeat WHERE id = 1",
      [WORKER_STALE_AFTER_SECONDS],
    );
    return rows[0]?.fresh ? "ok" : "stale";
  } catch {
    return "stale";
  }
}

export async function recordWorkerHeartbeat(): Promise<void> {
  await getSourcePool().query(
    `INSERT INTO worker_heartbeat (id, last_beat_at) VALUES (1, now())
     ON CONFLICT (id) DO UPDATE SET last_beat_at = now()`,
  );
}
