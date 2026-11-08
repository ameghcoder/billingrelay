import { afterEach, describe, expect, it, vi } from "vitest";
import { findWebhook, openReusedSession, openSession, PaypalError } from "./index";

// Unit tests of the token cache only, with PayPal stubbed. Real calls are counted by the sandbox check.
const tokenCalls: string[] = [];
let tokenNumber = 0;
let expiresIn = 32_400;

function stubPaypal(webhookStatus = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/oauth2/token")) {
        tokenCalls.push(new Headers(init.headers).get("authorization") ?? "");
        await new Promise((resolve) => setTimeout(resolve, 5));
        return Response.json({ access_token: `token-${++tokenNumber}`, scope: "a b", expires_in: expiresIn });
      }
      return Response.json({ webhooks: [] }, { status: webhookStatus });
    }),
  );
}

const credentials = (secret = "secret-1") => ({ environment: "sandbox" as const, clientId: `client-${secret}`, clientSecret: secret });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  tokenCalls.length = 0;
  expiresIn = 32_400;
});

describe("openReusedSession", () => {
  it("asks PayPal once for many calls, including concurrent ones", async () => {
    stubPaypal();
    const creds = credentials("concurrent");
    const sessions = await Promise.all([1, 2, 3, 4, 5].map(() => openReusedSession(creds)));
    await openReusedSession(creds);
    expect(tokenCalls).toHaveLength(1);
    expect(new Set(sessions.map((session) => session.accessToken)).size).toBe(1);
  });

  it("never gives a new secret the old secret's token", async () => {
    stubPaypal();
    const first = await openReusedSession(credentials("rotate-a"));
    const second = await openReusedSession({ ...credentials("rotate-a"), clientSecret: "rotate-b" });
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(tokenCalls).toHaveLength(2);
  });

  it("asks again 5 minutes before PayPal's expiry", async () => {
    stubPaypal();
    vi.useFakeTimers({ toFake: ["Date"] });
    expiresIn = 3_600;
    const creds = credentials("expiry");
    await openReusedSession(creds);
    vi.setSystemTime(Date.now() + 54 * 60_000);
    await openReusedSession(creds);
    expect(tokenCalls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await openReusedSession(creds);
    expect(tokenCalls).toHaveLength(2);
  });

  it("drops a token PayPal answers 401 to, as a safe-to-retry failure", async () => {
    stubPaypal(401);
    const creds = credentials("revoked");
    const session = await openReusedSession(creds);
    const error = await findWebhook(session, "https://example.test/hook").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaypalError);
    expect(error).toMatchObject({ kind: "unavailable", code: "token_expired" });
    await openReusedSession(creds);
    expect(tokenCalls).toHaveLength(2);
  });

  it("doesn't keep a failed token request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_client" }, { status: 401 })));
    const creds = credentials("bad");
    await expect(openReusedSession(creds)).rejects.toMatchObject({ kind: "rejected", code: "invalid_client" });
    stubPaypal();
    await expect(openReusedSession(creds)).resolves.toMatchObject({ accessToken: expect.stringMatching(/^token-/) });
  });
});

describe("openSession", () => {
  it("always asks PayPal, so a connection check is real", async () => {
    stubPaypal();
    const creds = credentials("fresh");
    await openSession(creds);
    await openSession(creds);
    expect(tokenCalls).toHaveLength(2);
  });
});
