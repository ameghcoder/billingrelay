import { and, asc, eq } from "drizzle-orm";
import { getDb } from "./client";
import { returnOrigin, type ProjectScope } from "./schema";

export type ReturnOriginRecord = { id: string; origin: string; createdAt: Date };

const columns = { id: returnOrigin.id, origin: returnOrigin.origin, createdAt: returnOrigin.createdAt };

const inScope = ({ projectId, environment }: ProjectScope) => and(eq(returnOrigin.projectId, projectId), eq(returnOrigin.environment, environment));

export async function listReturnOrigins(scope: ProjectScope): Promise<ReturnOriginRecord[]> {
  return getDb().select(columns).from(returnOrigin).where(inScope(scope)).orderBy(asc(returnOrigin.createdAt));
}

export async function isReturnOriginAllowed(scope: ProjectScope, origin: string): Promise<boolean> {
  const [row] = await getDb().select({ id: returnOrigin.id }).from(returnOrigin).where(and(inScope(scope), eq(returnOrigin.origin, origin)));
  return row !== undefined;
}

/** Safe to repeat: adding one that's already there changes nothing. */
export async function addReturnOrigin(values: ProjectScope & { origin: string; createdBy: string }): Promise<void> {
  await getDb().insert(returnOrigin).values(values).onConflictDoNothing({ target: [returnOrigin.projectId, returnOrigin.environment, returnOrigin.origin] });
}

/** Safe to repeat. Checkouts that already started keep their return address. */
export async function removeReturnOrigin(scope: ProjectScope, id: string): Promise<void> {
  await getDb().delete(returnOrigin).where(and(inScope(scope), eq(returnOrigin.id, id)));
}
