import { requireEnv } from "@billingrelay/db";
import { createAuthAdapter } from "@billingrelay/db/auth";
import { betterAuth } from "better-auth";

function createAuth() {
  return betterAuth({
    secret: requireEnv("BETTER_AUTH_SECRET"),
    baseURL: requireEnv("BETTER_AUTH_URL"),
    database: createAuthAdapter(),
    emailAndPassword: { enabled: true, disableSignUp: true },
    // Better Auth only enables this in production by default; dev should behave the same.
    rateLimit: { enabled: true },
  });
}

let auth: ReturnType<typeof createAuth> | undefined;

// Created on first use: `next build` loads this file without runtime env vars.
export function getAuth() {
  auth ??= createAuth();
  return auth;
}
