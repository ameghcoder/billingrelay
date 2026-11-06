import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { paypalConnection, project } from "./schema";

// Every read uses these columns, so the encrypted secret can't reach a caller by accident.
const safeColumns = {
  id: paypalConnection.id,
  projectId: paypalConnection.projectId,
  environment: paypalConnection.environment,
  clientId: paypalConnection.clientId,
  webhookId: paypalConnection.webhookId,
  webhookStatus: paypalConnection.webhookStatus,
  webhookError: paypalConnection.webhookError,
  capabilities: paypalConnection.capabilities,
  lastCheck: paypalConnection.lastCheck,
  lastCheckedAt: paypalConnection.lastCheckedAt,
};

export type PaypalConnectionRecord = Pick<typeof paypalConnection.$inferSelect, keyof typeof safeColumns>;

export type PaypalConnectionStatus = Pick<
  PaypalConnectionRecord,
  "webhookId" | "webhookStatus" | "webhookError" | "capabilities" | "lastCheck"
>;

/** The oldest project is the one `pnpm db:seed` creates. There's no project screen yet. */
export async function getDefaultProjectId(): Promise<string | null> {
  const [row] = await getDb().select({ id: project.id }).from(project).orderBy(asc(project.createdAt)).limit(1);
  return row?.id ?? null;
}

export async function getPaypalConnection(
  projectId: string,
  environment: "sandbox" | "live",
): Promise<PaypalConnectionRecord | null> {
  const [row] = await getDb()
    .select(safeColumns)
    .from(paypalConnection)
    .where(and(eq(paypalConnection.projectId, projectId), eq(paypalConnection.environment, environment)));
  return row ?? null;
}

/** For the webhook route, whose URL names the connection. */
export async function getPaypalConnectionById(connectionId: string): Promise<PaypalConnectionRecord | null> {
  const [row] = await getDb().select(safeColumns).from(paypalConnection).where(eq(paypalConnection.id, connectionId));
  return row ?? null;
}

export async function getPaypalConnectionSecret(connectionId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ secretEncrypted: paypalConnection.secretEncrypted })
    .from(paypalConnection)
    .where(eq(paypalConnection.id, connectionId));
  return row?.secretEncrypted ?? null;
}

export async function savePaypalCredentials(values: {
  projectId: string;
  environment: "sandbox" | "live";
  clientId: string;
  secretEncrypted: string;
}): Promise<PaypalConnectionRecord> {
  const [row] = await getDb()
    .insert(paypalConnection)
    .values(values)
    .onConflictDoUpdate({
      target: [paypalConnection.projectId, paypalConnection.environment],
      set: { clientId: values.clientId, secretEncrypted: values.secretEncrypted, updatedAt: sql`now()` },
    })
    .returning(safeColumns);
  return row!;
}

export async function updatePaypalConnectionStatus(
  connectionId: string,
  status: PaypalConnectionStatus,
): Promise<PaypalConnectionRecord> {
  const [row] = await getDb()
    .update(paypalConnection)
    .set({ ...status, lastCheckedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(paypalConnection.id, connectionId))
    .returning(safeColumns);
  return row!;
}
