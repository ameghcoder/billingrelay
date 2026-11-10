import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { getDb } from "./client";

type Runner = Pick<ReturnType<typeof getDb>, "execute">;

export type AuditEntry = {
  projectId: string;
  actorKind: "operator" | "ai" | "mcp";
  actorId: string;
  action: string;
  target?: string | null;
  // IDs, hashes and counts only: no prompt text, payloads or customer data.
  detail?: Record<string, unknown>;
};

export async function recordAudit(entry: AuditEntry, db: Runner = getDb()): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_event (id, project_id, actor_kind, actor_id, action, target, detail)
    VALUES (${uuidv7()}, ${entry.projectId}, ${entry.actorKind}, ${entry.actorId}, ${entry.action}, ${entry.target ?? null},
            ${entry.detail ? JSON.stringify(entry.detail) : null}::jsonb)`);
}

export async function listAudit(projectId: string, limit = 50): Promise<{ actorKind: string; actorId: string; action: string; target: string | null; detail: unknown; createdAt: Date }[]> {
  const { rows } = await getDb().execute<{ actor_kind: string; actor_id: string; action: string; target: string | null; detail: unknown; created_at: string }>(sql`
    SELECT actor_kind, actor_id, action, target, detail, created_at FROM audit_event WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT ${limit}`);
  return rows.map((row) => ({ actorKind: row.actor_kind, actorId: row.actor_id, action: row.action, target: row.target, detail: row.detail, createdAt: new Date(row.created_at) }));
}
