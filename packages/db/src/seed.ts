import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { closePools, getDb, requireEnv } from "./client";
import { account, user } from "./schema";

const MIN_PASSWORD_LENGTH = 12;

const email = requireEnv("OPERATOR_EMAIL").toLowerCase();
const password = requireEnv("OPERATOR_PASSWORD");
if (password.length < MIN_PASSWORD_LENGTH) {
  throw new Error(`OPERATOR_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
}

const db = getDb();

// There is one operator, so any existing user means seeding is already done.
const [existing] = await db.select({ id: user.id }).from(user).limit(1);
if (existing) {
  console.log("Operator already exists; nothing changed");
} else {
  // Written directly because signup is disabled, including for Better Auth's own server API.
  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(user).values({ id: userId, name: "Operator", email, emailVerified: true });
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
    });
  });
  console.log("Operator created");
}

await closePools();
