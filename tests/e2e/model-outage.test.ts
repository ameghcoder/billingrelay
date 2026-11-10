// Runs only against a stack whose web app was started with an OpenAI key that OpenAI refuses (E2E_MODEL_DOWN=1): the model is down.
// The AI routes say so plainly; quotes, checkouts and credits don't notice. Writes an API key, so only on a throwaway database.
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const RATE_LIMIT_WINDOW_MS = 11_000;

describe.runIf(process.env.E2E_MODEL_DOWN === "1")("the model is down", { timeout: 90_000 }, () => {
  const buyer = `model-down-${Date.now().toString(36)}`;
  let cookie: string;
  let apiKey: string;
  const admin = async (path: string, body: unknown) => {
    const res = await fetch(`${BASE_URL}${path}`, { method: "POST", headers: { Cookie: cookie, Origin: BASE_URL, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const v1 = async (path: string, body: unknown, idempotencyKey?: string) => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    const signIn = () =>
      fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL },
        body: JSON.stringify({ email: process.env.OPERATOR_EMAIL, password: process.env.OPERATOR_PASSWORD }),
      });
    let res = await signIn();
    if (res.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WINDOW_MS));
      res = await signIn();
    }
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.includes("session_token"))!;
    apiKey = (await admin("/admin/developers/api-keys", { name: "e2e model down" })).body.key;
    expect((await admin("/admin/developers/return-origins", { origin: "https://a.example" })).status).toBeLessThan(500);
  });

  it("AI setup says the model didn't answer", async () => {
    const res = await admin("/admin/ai/draft", { message: "A $9 monthly membership with 100 credits." });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ai_unavailable");
  });

  it("while billing doesn't notice: a quote, a checkout and a spend answer as they would anyway", async () => {
    const quote = await v1("/v1/quotes", { externalCustomerId: buyer, item: { ref: "down", name: "Down" }, unitAmount: 300, currency: "USD" }, `q-${buyer}`);
    expect(quote.status).toBe(201);
    const checkout = await v1("/v1/checkouts", { externalCustomerId: buyer, quoteId: quote.body.id, returnUrl: "https://a.example/r" }, `c-${buyer}`);
    // A checkout needs PayPal, never the model: with no PayPal connection it's refused for that alone.
    if (process.env.E2E_PAYPAL === "1") expect(checkout).toMatchObject({ status: 201, body: { money: "pending" } });
    else expect(checkout).toMatchObject({ status: 422, body: { error: { code: "paypal_not_connected" } } });
    const spend = await v1("/v1/credits/consume", { externalCustomerId: buyer, amount: 1, usageId: `u-${buyer}` });
    expect(spend.status).toBe(422);
    expect(spend.body.error.code).toBe("insufficient_credits");
  });
});
