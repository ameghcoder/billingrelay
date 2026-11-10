import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "./client";
import { apiKey, type ProjectScope } from "./schema";

const summaryColumns = {
  id: apiKey.id,
  name: apiKey.name,
  environment: apiKey.environment,
  kind: apiKey.kind,
  lastFour: apiKey.lastFour,
  createdAt: apiKey.createdAt,
  revokedAt: apiKey.revokedAt,
};

export type ApiKeyRecord = {
  id: string;
  name: string;
  environment: "sandbox" | "live";
  kind: "backend" | "mcp";
  lastFour: string;
  createdAt: Date;
  revokedAt: Date | null;
};

export async function createApiKey(
  values: ProjectScope & { name: string; kind: "backend" | "mcp"; keyHash: string; lastFour: string; createdBy: string },
): Promise<ApiKeyRecord> {
  const [row] = await getDb().insert(apiKey).values(values).returning(summaryColumns);
  return row!;
}

export async function listApiKeys({ projectId, environment }: ProjectScope): Promise<ApiKeyRecord[]> {
  return getDb()
    .select(summaryColumns)
    .from(apiKey)
    .where(and(eq(apiKey.projectId, projectId), eq(apiKey.environment, environment)))
    .orderBy(desc(apiKey.createdAt));
}

/** Safe to repeat: the first revocation's time is kept. */
export async function revokeApiKey({ projectId, environment }: ProjectScope, id: string): Promise<ApiKeyRecord | null> {
  const [row] = await getDb()
    .update(apiKey)
    .set({ revokedAt: sql`COALESCE(${apiKey.revokedAt}, now())` })
    .where(and(eq(apiKey.id, id), eq(apiKey.projectId, projectId), eq(apiKey.environment, environment)))
    .returning(summaryColumns);
  return row ?? null;
}

export type ActiveApiKey = ProjectScope & { id: string; kind: "backend" | "mcp"; createdBy: string };

/** A revoked key stops working on its next request, because nothing here is cached. */
export async function findActiveApiKey(keyHash: string): Promise<ActiveApiKey | null> {
  const [row] = await getDb()
    .select({ id: apiKey.id, projectId: apiKey.projectId, environment: apiKey.environment, kind: apiKey.kind, createdBy: apiKey.createdBy })
    .from(apiKey)
    .where(and(eq(apiKey.keyHash, keyHash), isNull(apiKey.revokedAt)));
  return row ?? null;
}
