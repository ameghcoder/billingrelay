import { and, eq } from "drizzle-orm";
import { getDb } from "./client";
import { customer } from "./schema";

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** Inside a caller's transaction, so a rollback there removes a new customer too. */
export async function ensureCustomer(tx: Transaction, projectId: string, externalCustomerId: string): Promise<string> {
  await tx.insert(customer).values({ projectId, externalCustomerId }).onConflictDoNothing({ target: [customer.projectId, customer.externalCustomerId] });
  // A separate statement sees a row another request committed while this one waited on the insert above.
  const [owner] = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(and(eq(customer.projectId, projectId), eq(customer.externalCustomerId, externalCustomerId)));
  return owner!.id;
}
