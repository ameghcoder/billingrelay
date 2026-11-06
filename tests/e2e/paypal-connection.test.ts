// Runs against a live stack (see README). The E2E_PAYPAL block calls real PayPal sandbox and saves a
// connection, so run it only against a throwaway database.
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const CONNECTIONS = "/admin/paypal/connections";
const SANDBOX = `${CONNECTIONS}/sandbox`;

let cookie: string;

const send = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}${path}`, {
    redirect: "manual",
    ...init,
    headers: { Cookie: cookie, Origin: BASE_URL, "Content-Type": "application/json", ...init.headers },
  });

const save = (body: object, init: RequestInit = {}) => send(SANDBOX, { method: "PUT", body: JSON.stringify(body), ...init });

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email: process.env.OPERATOR_EMAIL, password: process.env.OPERATOR_PASSWORD }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.includes("session_token"))!;
});

describe("requests refused before any PayPal call", () => {
  it("refuses live", async () => {
    const res = await send(`${CONNECTIONS}/live`, {
      method: "PUT",
      body: JSON.stringify({ clientId: "id", clientSecret: "secret" }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("live_disabled");
  });

  it("returns 404 for an unknown environment", async () => {
    const res = await send(`${CONNECTIONS}/staging/check`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it.each([
    ["no fields", {}],
    ["an empty secret", { clientId: "id", clientSecret: "   " }],
    ["an extra field", { clientId: "id", clientSecret: "secret", environment: "live" }],
  ])("rejects %s", async (_name, body) => {
    const res = await save(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  it.each([
    ["another site", { Origin: "https://evil.example" }],
    ["a look-alike origin", { Origin: `${BASE_URL}.evil.example` }],
  ])("rejects a signed-in request from %s", async (_name, headers) => {
    const res = await save({ clientId: "id", clientSecret: "secret" }, { headers });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_origin");
  });

  it("rejects a signed-in request with no Origin header", async () => {
    const res = await fetch(`${BASE_URL}${SANDBOX}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "id", clientSecret: "secret" }),
    });
    expect(res.status).toBe(403);
  });
});

describe.runIf(process.env.E2E_PAYPAL === "1")("real PayPal sandbox", { timeout: 60_000 }, () => {
  const clientId = process.env.PAYPAL_CLIENT_ID!;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET!;
  const readBack = async () => (await (await send(CONNECTIONS)).json()).connections;

  it("rejects a wrong secret and saves nothing", async () => {
    // Not "no connection": other test files may have connected first.
    const before = await readBack();
    const res = await save({ clientId, clientSecret: "wrong-secret" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("paypal_credentials_rejected");
    expect(await readBack()).toEqual(before);
  });

  it("connects, and returns only safe fields", async () => {
    const res = await save({ clientId, clientSecret });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const text = await res.text();
    // Booleans on purpose: a failed string assertion would print the secret into the test output.
    expect(text.includes(clientSecret)).toBe(false);
    expect(text.includes(clientId)).toBe(false);

    const view = JSON.parse(text);
    expect(view.secretStored).toBe(true);
    expect(view.lastCheck).toBe("ok");
    expect(view.webhook.status).toBe("registered");
    expect(view.capabilities).toEqual({ checkout: true, subscriptions: true, webhooks: true });
    expect(Object.keys(view).sort()).toEqual(
      ["capabilities", "clientId", "environment", "lastCheck", "lastCheckedAt", "secretStored", "webhook"].sort(),
    );
  });

  it("keeps the connection when a later save has a wrong secret", async () => {
    const before = await readBack();
    const res = await save({ clientId, clientSecret: "wrong-secret" });
    expect(res.status).toBe(422);
    expect(await readBack()).toEqual(before);
    const check = await send(`${SANDBOX}/check`, { method: "POST" });
    expect((await check.json()).lastCheck).toBe("ok");
  });

  it("saving again keeps one connection with the same webhook", async () => {
    const [before] = await readBack();
    const res = await save({ clientId, clientSecret });
    expect(res.status).toBe(200);
    const after = await readBack();
    expect(after).toHaveLength(1);
    expect(after[0].webhook.url).toBe(before.webhook.url);
  });
});
