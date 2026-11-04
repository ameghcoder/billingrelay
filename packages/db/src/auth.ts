import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb } from "./client";
import { account, session, user, verification } from "./schema";

// Keeps Drizzle inside this package while Better Auth gets the adapter it needs.
export function createAuthAdapter() {
  return drizzleAdapter(getDb(), {
    provider: "pg",
    schema: { user, session, account, verification },
  });
}
