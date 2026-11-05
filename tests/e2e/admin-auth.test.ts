// Runs against a live stack (see README). Every check goes through HTTP, like a real caller.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const APP_DIR = "apps/web/app";
const ADMIN_DIR = `${APP_DIR}/admin`;
const V1_DIR = `${APP_DIR}/v1`;
const RATE_LIMIT_WINDOW_MS = 11_000;
const email = process.env.OPERATOR_EMAIL!;
const password = process.env.OPERATOR_PASSWORD!;

const request = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}${path}`, { redirect: "manual", ...init });

const signIn = (body: object, origin = BASE_URL) =>
  request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });

const sessionCookie = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]!)
    .find((cookie) => cookie.includes("session_token") && !cookie.endsWith("="));

function urlPath(file: string): string {
  const parts = relative(APP_DIR, join(file, "..")).split(sep).filter(Boolean);
  const segments = parts
    .filter((part) => !/^\(.*\)$/.test(part))
    .map((part) => part.replace(/^\[+\.*(.+?)\]+$/, "$1"));
  return ["", ...segments].join("/");
}

const filesIn = (dir: string) => readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => join(dir, f));

const routesIn = (dir: string) =>
  filesIn(dir)
    .filter((f) => f.endsWith("route.ts"))
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const methods = [...source.matchAll(/export\s+(?:const|async function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
      expect(methods.length, `${file} exports no HTTP methods`).toBeGreaterThan(0);
      return methods.map((m) => ({ method: m[1]!, path: urlPath(file) }));
    });

const pages = filesIn(ADMIN_DIR).filter((f) => f.endsWith("page.tsx"));
const routes = routesIn(ADMIN_DIR);
const v1Routes = routesIn(V1_DIR);

describe("without a session", () => {
  it("finds admin pages and routes to check", () => {
    expect(pages.length).toBeGreaterThan(0);
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(pages.map((file) => urlPath(file)))("page %s redirects to /login", async (path) => {
    const res = await request(path);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it.each(routes)("$method $path returns 401 with no data", async ({ method, path }) => {
    const res = await request(path, { method });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Sign in to continue" } });
  });

  it("rejects a forged session cookie", async () => {
    const res = await request("/admin/me", {
      headers: { Cookie: "better-auth.session_token=forged.forged" },
    });
    expect(res.status).toBe(401);
  });
});

describe("without an API key", () => {
  it("finds /v1 routes to check", () => {
    expect(v1Routes.length).toBeGreaterThan(0);
  });

  it.each(v1Routes)("$method $path returns 401 with no data", async ({ method, path }) => {
    const res = await request(path, { method });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_api_key");
  });
});

describe("sign-in", () => {
  // Sign-in allows 3 attempts per 10s, so each test starts with a fresh window.
  beforeEach(() => new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WINDOW_MS)), RATE_LIMIT_WINDOW_MS + 2_000);

  it("rejects a wrong password and a wrong email the same way, with no session", async () => {
    const wrongPassword = await signIn({ email, password: "not-the-password" });
    const wrongEmail = await signIn({ email: "nobody@example.com", password: "not-the-password" });
    expect(wrongPassword.status).toBe(401);
    expect(wrongEmail.status).toBe(401);
    expect(sessionCookie(wrongPassword)).toBeUndefined();
    expect(sessionCookie(wrongEmail)).toBeUndefined();
    expect(await wrongPassword.json()).toEqual(await wrongEmail.json());
  });

  it("rejects signup", { timeout: 10_000 }, async () => {
    const res = await request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ name: "Attacker", email: "attacker@example.com", password: "long-enough-password" }),
    });
    expect(res.ok).toBe(false);
    expect(sessionCookie(res)).toBeUndefined();
    expect((await signIn({ email: "attacker@example.com", password: "long-enough-password" })).status).toBe(401);
  });

  it("rejects sign-in from another origin", async () => {
    const res = await signIn({ email, password }, "https://evil.example");
    expect(res.status).toBe(403);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it("rate limits repeated attempts, even with the right password", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await signIn({ email, password: "not-the-password" })).status).toBe(401);
    }
    const res = await signIn({ email, password });
    expect(res.status).toBe(429);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it("opens /admin after login, and sign-out ends the session", async () => {
    const res = await signIn({ email, password });
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).toBeDefined();
    const setCookie = res.headers.getSetCookie().find((c) => c.includes("session_token"))!;
    expect(setCookie.toLowerCase()).toContain("httponly");

    const headers = { Cookie: cookie! };
    expect((await request("/admin", { headers })).status).toBe(200);
    const me = await request("/admin/me", { headers });
    expect(me.status).toBe(200);
    expect((await me.json()).operator.email).toBe(email.toLowerCase());

    const out = await request("/api/auth/sign-out", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Origin: BASE_URL },
      body: "{}",
    });
    expect(out.status).toBe(200);
    expect((await request("/admin/me", { headers })).status).toBe(401);
  });
});

describe("health", () => {
  it("is public and returns statuses only", async () => {
    const res = await request("/api/health");
    expect(Object.keys(await res.json()).sort()).toEqual(["destination", "source", "worker"]);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
