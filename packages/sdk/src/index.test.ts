import { describe, expect, it } from "vitest";
import { BillingRelayError, createBillingRelay } from "./index";

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };

function stub(status: number, answer: unknown) {
  const sent: Sent[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status, headers: { "Content-Type": "application/json" } });
  };
  return { sent, client: createBillingRelay({ baseUrl: "https://billing.example.com/", apiKey: "br_sandbox_test", fetch: fetch as typeof globalThis.fetch }) };
}

const balance = { monthly: 0, packs: 40, total: 40, monthlyEndsAt: null };

describe("the server SDK", () => {
  it("sends the key, the body and the idempotency key to the right path", async () => {
    const { sent, client } = stub(201, { usageId: "u1", debited: 10, balance });
    await client.credits.consume({ externalCustomerId: "user_1", amount: 10, usageId: "u1" });
    expect(sent[0]).toMatchObject({ url: "https://billing.example.com/v1/credits/consume", method: "POST", body: { externalCustomerId: "user_1", amount: 10, usageId: "u1" } });
    expect(sent[0]!.headers).toMatchObject({ Authorization: "Bearer br_sandbox_test", "Content-Type": "application/json" });
    expect(sent[0]!.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("puts the idempotency key in its header on a checkout", async () => {
    const { sent, client } = stub(400, { error: { code: "invalid_request", message: "x" } });
    await expect(client.checkouts.create({ externalCustomerId: "user_1", productRef: "pro", returnUrl: "https://a.example/r" }, { idempotencyKey: "order-7" })).rejects.toThrow();
    expect(sent[0]!.headers["Idempotency-Key"]).toBe("order-7");
  });

  it("escapes IDs in the path and sends no body on a read", async () => {
    const { sent, client } = stub(200, { externalCustomerId: "a/b c" });
    await client.customers.billing("a/b c").catch(() => undefined);
    expect(sent[0]).toMatchObject({ url: "https://billing.example.com/v1/customers/a%2Fb%20c/billing", method: "GET", body: undefined });
    expect(sent[0]!.headers["Content-Type"]).toBeUndefined();
  });

  it("a refusal becomes an error with BillingRelay's code and details", async () => {
    const { client } = stub(409, { error: { code: "insufficient_credits", message: "Not enough", details: { balance } } });
    const error = await client.credits.consume({ externalCustomerId: "user_1", amount: 999, usageId: "u2" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BillingRelayError);
    expect(error).toMatchObject({ status: 409, code: "insufficient_credits", message: "Not enough", details: { balance } });
  });

  it("an answer that isn't BillingRelay's JSON still becomes a typed error", async () => {
    const { client } = stub(502, "<html>Bad gateway</html>");
    await expect(client.credits.compensate("u1")).rejects.toMatchObject({ status: 502, code: "http_error" });
  });

  it("a success in the wrong shape is refused rather than handed on", async () => {
    const { client } = stub(200, { usageId: "u1", debited: "10" });
    await expect(client.credits.consume({ externalCustomerId: "user_1", amount: 10, usageId: "u1" })).rejects.toThrow();
  });
});
