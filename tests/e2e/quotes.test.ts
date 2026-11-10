// Runs against a live stack (see README). Every check goes through HTTP, like a real caller. The E2E_WRITE_DB
// block creates API keys, catalog versions and quotes, so run it only against a throwaway database.
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const QUOTES = "/v1/quotes";
const KEYS = "/admin/developers/api-keys";
const DRAFTS = "/admin/config/drafts";
const UNKNOWN_ID = "01900000-0000-7000-8000-000000000000";
const RATE_LIMIT_WINDOW_MS = 11_000;

let cookie: string;

async function signIn() {
  const attempt = () =>
    fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ email: process.env.OPERATOR_EMAIL, password: process.env.OPERATOR_PASSWORD }),
    });
  let res = await attempt();
  // Other test files sign in too, and sign-in allows 3 attempts per 10s.
  if (res.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WINDOW_MS));
    res = await attempt();
  }
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.includes("session_token"))!;
}

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}${path}`, {
    redirect: "manual",
    ...init,
    headers: { Cookie: cookie, Origin: BASE_URL, "Content-Type": "application/json", ...init.headers },
  });

const adminPost = (path: string, body?: unknown) =>
  admin(path, { method: "POST", ...(body !== undefined && { body: JSON.stringify(body) }) });

let keyNumber = 0;
const newKey = (prefix = "e2e") => `${prefix}-${Date.now()}-${keyNumber++}`;

const CUSTOMER = "app-user-42";

const postQuote = (apiKey: string, body: unknown, idempotencyKey: string | null = newKey(), headers: Record<string, string> = {}) =>
  fetch(`${BASE_URL}${QUOTES}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const checkQuote = (apiKey: string, id: string, externalCustomerId: unknown = CUSTOMER) =>
  fetch(`${BASE_URL}${QUOTES}/${id}/check`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ externalCustomerId }),
  });

const errorCode = async (res: Response) => (await res.json()).error.code as string;
const fieldPaths = async (res: Response) => ((await res.json()).error.details.fields as { path: string }[]).map((field) => field.path);

const price = (amount: number, currency = "USD") => ({ amount, currency });

const catalog = (extendedAmount = 2900) => ({
  products: [
    {
      ref: "q-template",
      name: "Creator template",
      kind: "one_time",
      fields: [{ key: "license", label: "License", type: "enum", required: true, options: ["standard", "extended"] }],
      variants: [
        { ref: "standard-license", name: "Standard", attributes: { license: "standard" }, price: price(900), benefits: [] },
        {
          ref: "extended-license",
          name: "Extended",
          attributes: { license: "extended" },
          price: price(extendedAmount),
          benefits: [{ kind: "access", key: "commercial-use" }],
        },
      ],
    },
    {
      ref: "q-pro",
      name: "Pro",
      kind: "subscription",
      variants: [{ ref: "monthly", name: "Monthly", price: price(1900), benefits: [{ kind: "access", key: "pro" }] }],
    },
    {
      ref: "q-pack",
      name: "5,000 credits",
      kind: "credit_pack",
      maxQuantity: 5,
      variants: [{ ref: "default", name: "5,000 credits", price: price(500), benefits: [{ kind: "credits", amount: 5000 }] }],
    },
  ],
});

async function publishCatalog(config: object) {
  const versions = (await (await admin(DRAFTS)).json()).versions as { version: number }[];
  const saved = await adminPost(DRAFTS, { baseVersion: versions[0]?.version ?? 0, config });
  expect(saved.status).toBe(201);
  const { id, version } = (await saved.json()) as { id: string; version: number };
  expect((await adminPost(`${DRAFTS}/${id}/approve`)).status).toBe(200);
  expect((await adminPost(`${DRAFTS}/${id}/activate`)).status).toBe(200);
  return version;
}

const extended = (overrides: object = {}) => ({ externalCustomerId: CUSTOMER, productRef: "q-template", variantRef: "extended-license", ...overrides });
const merchant = (overrides: object = {}) => ({
  externalCustomerId: CUSTOMER,
  item: { ref: "poster-42", name: "Poster #42" },
  unitAmount: 1500,
  currency: "USD",
  ...overrides,
});

describe("without a valid key", () => {
  const send = (headers: Record<string, string>) =>
    fetch(`${BASE_URL}${QUOTES}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": newKey(), ...headers },
      body: JSON.stringify(merchant()),
    });

  it.each<[string, Record<string, string>]>([
    ["no header", {}],
    ["an empty header", { Authorization: "" }],
    ["a wrong key", { Authorization: "Bearer br_sandbox_not-a-real-key" }],
    ["the wrong scheme", { Authorization: "Basic YTpi" }],
    ["two values", { Authorization: "Bearer a b" }],
    ["a bare key", { Authorization: "br_sandbox_not-a-real-key" }],
  ])("refuses %s", async (_name, headers) => {
    const res = await send(headers);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await errorCode(res)).toBe("invalid_api_key");
  });

  it("gives a website nothing to read: no CORS headers, even on a preflight", async () => {
    const preflight = await fetch(`${BASE_URL}${QUOTES}`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-headers")).toBeNull();
  });
});

describe.runIf(process.env.E2E_WRITE_DB === "1")("with a key", () => {
  let apiKey: string;
  let catalogVersion: number;

  beforeAll(async () => {
    cookie = await signIn();
    const created = await adminPost(KEYS, { name: "e2e" });
    expect(created.status).toBe(201);
    apiKey = (await created.json()).key;
    catalogVersion = await publishCatalog(catalog());
  }, 30_000);

  describe("API key management", () => {
    it("shows the full key only when it's created", async () => {
      const created = await adminPost(KEYS, { name: "shown once" });
      const { id, key, lastFour } = await created.json();
      expect(key).toMatch(/^br_sandbox_[A-Za-z0-9_-]{43}$/);
      expect(key.slice(-4)).toBe(lastFour);
      expect(created.headers.get("cache-control")).toContain("no-store");

      const list = await (await admin(KEYS)).text();
      expect(list).toContain(id);
      expect(list).not.toContain(key);
      expect(list).not.toContain("hash");
    });

    it("refuses a bad name and any attempt to choose the environment", async () => {
      expect((await adminPost(KEYS, { name: "" })).status).toBe(400);
      const live = await adminPost(KEYS, { name: "x", environment: "live" });
      expect(live.status).toBe(400);
      expect(await fieldPaths(live)).toContain("environment");
    });

    it("stops a revoked key on its next request, and revoking twice keeps the first time", async () => {
      const { id, key } = await (await adminPost(KEYS, { name: "to revoke" })).json();
      expect((await postQuote(key, merchant())).status).toBe(201);

      const first = await adminPost(`${KEYS}/${id}/revoke`);
      expect(first.status).toBe(200);
      const { revokedAt } = await first.json();
      expect(revokedAt).toBeTruthy();

      const res = await postQuote(key, merchant());
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe("invalid_api_key");

      expect((await (await adminPost(`${KEYS}/${id}/revoke`)).json()).revokedAt).toBe(revokedAt);
    });

    it.each(["not-a-uuid", UNKNOWN_ID])("returns 404 when revoking %s", async (id) => {
      expect((await adminPost(`${KEYS}/${id}/revoke`)).status).toBe(404);
    });

    it("doesn't accept the operator's login in place of a key", async () => {
      const res = await fetch(`${BASE_URL}${QUOTES}`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: BASE_URL, "Content-Type": "application/json", "Idempotency-Key": newKey() },
        body: JSON.stringify(merchant()),
      });
      expect(res.status).toBe(401);
    });

    it("doesn't accept a key on /admin", async () => {
      const res = await fetch(`${BASE_URL}${KEYS}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      expect(res.status).toBe(401);
    });
  });

  describe("quotes from the live catalog", () => {
    it("takes the exact price, benefits and version from it", async () => {
      const res = await postQuote(apiKey, extended());
      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const quote = await res.json();
      expect(quote).toMatchObject({
        externalCustomerId: CUSTOMER,
        status: "open",
        snapshot: {
          source: "catalog",
          catalogVersion,
          product: { ref: "q-template", kind: "one_time" },
          variant: { ref: "extended-license", attributes: { license: "extended" } },
          quantity: 1,
          unitAmount: 2900,
          amount: 2900,
          currency: "USD",
          benefits: [{ kind: "access", key: "commercial-use" }],
        },
      });
      const minutes = (Date.parse(quote.expiresAt) - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(29);
      expect(minutes).toBeLessThanOrEqual(30);
    });

    it("gives each variant its own price, and multiplies a pack", async () => {
      const standard = await (await postQuote(apiKey, extended({ variantRef: "standard-license" }))).json();
      expect(standard.snapshot).toMatchObject({ unitAmount: 900, amount: 900, benefits: [] });

      const pack = await (await postQuote(apiKey, { externalCustomerId: CUSTOMER, productRef: "q-pack", quantity: 2 })).json();
      expect(pack.snapshot).toMatchObject({ quantity: 2, unitAmount: 500, amount: 1000, benefits: [{ kind: "credits", amount: 5000 }] });
    });

    it.each(["unitAmount", "amount", "currency", "price", "benefits", "status", "expiresAt", "catalogVersion", "snapshot"])(
      "refuses a tampered %s and stores nothing",
      async (field) => {
        const idempotencyKey = newKey();
        const res = await postQuote(apiKey, extended({ [field]: 1 }), idempotencyKey);
        expect(res.status).toBe(400);
        expect(await errorCode(res.clone())).toBe("invalid_request");
        expect(await fieldPaths(res)).toContain(field);
        // Nothing was stored against the key, so the honest request still works with it.
        expect((await postQuote(apiKey, extended(), idempotencyKey)).status).toBe(201);
      },
    );

    it.each<[string, object, string]>([
      ["a subscription", { productRef: "q-pro", variantRef: undefined }, "not_quotable"],
      ["an unknown product", { productRef: "nope", variantRef: undefined }, "unknown_product"],
      ["an unknown variant", { variantRef: "nope" }, "unknown_variant"],
      ["a missing variant", { variantRef: undefined }, "variant_required"],
      ["too many", { quantity: 2 }, "quantity_too_large"],
    ])("refuses %s and stores nothing", async (_name, overrides, code) => {
      const idempotencyKey = newKey();
      const res = await postQuote(apiKey, extended(overrides), idempotencyKey);
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe(code);
      expect((await postQuote(apiKey, extended(), idempotencyKey)).status).toBe(201);
    });

    it("refuses a product that's only in a draft", async () => {
      const versions = (await (await admin(DRAFTS)).json()).versions as { version: number }[];
      const draft = { ...catalog(), products: [...catalog().products, { ...catalog().products[2]!, ref: "q-draft-only" }] };
      expect((await adminPost(DRAFTS, { baseVersion: versions[0]!.version, config: draft })).status).toBe(201);
      const res = await postQuote(apiKey, { externalCustomerId: CUSTOMER, productRef: "q-draft-only" });
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe("unknown_product");
    });
  });

  describe("quotes from the merchant's own catalog", () => {
    it("uses the sent price and grants what's allowed", async () => {
      const res = await postQuote(apiKey, merchant({ quantity: 3, benefits: [{ kind: "access", key: "poster" }], metadata: { order: "A-1009" } }));
      expect(res.status).toBe(201);
      expect((await res.json()).snapshot).toEqual({
        source: "merchant",
        catalogVersion: null,
        product: { ref: "poster-42", name: "Poster #42", kind: "one_time" },
        variant: null,
        quantity: 3,
        unitAmount: 1500,
        amount: 4500,
        currency: "USD",
        benefits: [{ kind: "access", key: "poster" }],
        metadata: { order: "A-1009" },
      });
    });

    it.each<[string, object, string]>([
      ["a decimal", { unitAmount: 9.5 }, "unitAmount"],
      ["text", { unitAmount: "900" }, "unitAmount"],
      ["zero", { unitAmount: 0 }, "unitAmount"],
      ["a negative", { unitAmount: -1 }, "unitAmount"],
      ["too large", { unitAmount: 100_000_000 }, "unitAmount"],
      ["JPY", { currency: "JPY" }, "currency"],
      ["an unknown currency", { currency: "XXX" }, "currency"],
      ["credits", { benefits: [{ kind: "credits", amount: 1_000_000 }] }, "benefits.0.kind"],
      ["a catalog field", { productRef: "q-template" }, "productRef"],
    ])("refuses %s, naming the field", async (_name, overrides, path) => {
      const res = await postQuote(apiKey, merchant(overrides));
      expect(res.status).toBe(400);
      expect(await fieldPaths(res)).toContain(path);
    });

    it("can't undercut a catalog price", async () => {
      const res = await postQuote(apiKey, merchant({ item: { ref: "q-template", name: "Cheap" }, unitAmount: 1 }));
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe("product_in_catalog");
    });

    it("refuses a total over the limit", async () => {
      const res = await postQuote(apiKey, merchant({ unitAmount: 50_000_000, quantity: 2 }));
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe("amount_too_large");
    });
  });

  describe("requests that can't be read", () => {
    it.each<[string, string | null]>([
      ["no Idempotency-Key", null],
      ["one with a space", "has space"],
    ])("refuses %s", async (_name, idempotencyKey) => {
      const res = await postQuote(apiKey, merchant(), idempotencyKey);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("idempotency_key_required");
    });

    it.each<[string, string]>([
      ["no body", ""],
      ["broken JSON", "{not json"],
      ["null", "null"],
      ["an array", "[]"],
    ])("refuses %s", async (_name, body) => {
      const res = await postQuote(apiKey, body);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_request");
    });

    it("refuses a body over 64 KB, with or without a declared length", async () => {
      const large = JSON.stringify(merchant({ metadata: { a: "x".repeat(70_000) } }));
      expect((await postQuote(apiKey, large)).status).toBe(413);

      const stream = new Blob([large]).stream();
      const res = await fetch(`${BASE_URL}${QUOTES}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": newKey() },
        body: stream,
        duplex: "half",
      } as RequestInit);
      expect(res.status).toBe(413);
    });
  });

  describe("retrying", () => {
    it("returns the same quote for the same key and body", async () => {
      const idempotencyKey = newKey();
      const first = await postQuote(apiKey, extended({ metadata: { a: "1", b: "2" } }), idempotencyKey);
      expect(first.status).toBe(201);
      const stored = await first.text();

      const retry = await postQuote(apiKey, extended({ metadata: { a: "1", b: "2" } }), idempotencyKey);
      expect(retry.status).toBe(200);
      expect(await retry.text()).toBe(stored);
    });

    it("treats reordered JSON and a left-out default as the same request", async () => {
      const idempotencyKey = newKey();
      const { id } = await (await postQuote(apiKey, extended({ quantity: 1, expiresInSeconds: 1800 }), idempotencyKey)).json();

      const reordered = `{"variantRef":"extended-license","productRef":"q-template","externalCustomerId":"${CUSTOMER}"}`;
      const retry = await postQuote(apiKey, reordered, idempotencyKey);
      expect(retry.status).toBe(200);
      expect((await retry.json()).id).toBe(id);
    });

    it.each<[string, object]>([
      ["a different variant", { variantRef: "standard-license" }],
      ["a different customer", { externalCustomerId: "someone-else" }],
      ["different metadata", { metadata: { a: "1" } }],
      ["a different expiry", { expiresInSeconds: 60 }],
    ])("refuses the same key with %s", async (_name, overrides) => {
      const idempotencyKey = newKey();
      const { id } = await (await postQuote(apiKey, extended(), idempotencyKey)).json();

      const res = await postQuote(apiKey, extended(overrides), idempotencyKey);
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("idempotency_conflict");
      expect((await (await postQuote(apiKey, extended(), idempotencyKey)).json()).id).toBe(id);
    });

    it("gives 20 requests with one key one quote, and everyone the same answer", async () => {
      const idempotencyKey = newKey();
      const responses = await Promise.all(Array.from({ length: 20 }, () => postQuote(apiKey, extended(), idempotencyKey)));
      const statuses = responses.map((res) => res.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 200)).toHaveLength(19);
      const ids = await Promise.all(responses.map(async (res) => (await res.json()).id));
      expect(new Set(ids).size).toBe(1);
    });

    it("gives 20 requests for one new customer 20 quotes and no 500s", async () => {
      const externalCustomerId = newKey("new-customer");
      const responses = await Promise.all(Array.from({ length: 20 }, () => postQuote(apiKey, extended({ externalCustomerId }))));
      expect(responses.map((res) => res.status)).toEqual(Array(20).fill(201));
      const ids = await Promise.all(responses.map(async (res) => (await res.json()).id));
      expect(new Set(ids).size).toBe(20);
    });

    it("still finds the quote after the API key is replaced", async () => {
      const idempotencyKey = newKey();
      const { id } = await (await postQuote(apiKey, extended(), idempotencyKey)).json();
      const replacement = (await (await adminPost(KEYS, { name: "replacement" })).json()).key;

      const retry = await postQuote(replacement, extended(), idempotencyKey);
      expect(retry.status).toBe(200);
      expect((await retry.json()).id).toBe(id);
    });
  });

  describe("using a quote", () => {
    it("passes for its customer, returning the stored quote", async () => {
      const created = await postQuote(apiKey, extended());
      const stored = await created.text();
      const { id } = JSON.parse(stored);

      const res = await checkQuote(apiKey, id);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(stored);
    });

    it.each(["someone-else", "APP-USER-42"])("refuses %s", async (customer) => {
      const { id } = await (await postQuote(apiKey, extended())).json();
      const res = await checkQuote(apiKey, id, customer);
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe("quote_customer_mismatch");
    });

    it("needs a customer, and no other field", async () => {
      const { id } = await (await postQuote(apiKey, extended())).json();
      expect((await checkQuote(apiKey, id, "")).status).toBe(400);
      const extra = await fetch(`${BASE_URL}${QUOTES}/${id}/check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ externalCustomerId: CUSTOMER, amount: 1 }),
      });
      expect(extra.status).toBe(400);
    });

    it.each(["not-a-uuid", UNKNOWN_ID, "' OR 1=1 --"])("returns 404 for quote %j", async (id) => {
      expect((await checkQuote(apiKey, encodeURIComponent(id))).status).toBe(404);
    });

    it.each(["GET", "PUT", "PATCH", "DELETE"])("has no %s route to read or change a quote", async (method) => {
      const { id } = await (await postQuote(apiKey, extended())).json();
      const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
      const body = method === "GET" ? undefined : JSON.stringify({ amount: 1 });
      expect((await fetch(`${BASE_URL}${QUOTES}/${id}`, { method, headers, body })).status).toBe(404);
      expect((await fetch(`${BASE_URL}${QUOTES}/${id}/check`, { method, headers, body })).status).toBe(405);
    });
  });

  describe("when the price changes", () => {
    it("keeps the quote's price, byte for byte, and new quotes get the new one", async () => {
      const idempotencyKey = newKey();
      const before = await (await postQuote(apiKey, extended(), idempotencyKey)).text();
      const { id, snapshot } = JSON.parse(before);
      expect(snapshot.unitAmount).toBe(2900);

      const nextVersion = await publishCatalog(catalog(3900));

      expect(await (await checkQuote(apiKey, id)).text()).toBe(before);
      expect(await (await postQuote(apiKey, extended(), idempotencyKey)).text()).toBe(before);

      const fresh = await (await postQuote(apiKey, extended())).json();
      expect(fresh.snapshot).toMatchObject({ unitAmount: 3900, catalogVersion: nextVersion });
    });

    it("keeps a quote open when its product is removed, until it expires", async () => {
      const { id } = await (await postQuote(apiKey, { externalCustomerId: CUSTOMER, productRef: "q-pack" })).json();
      await publishCatalog({ products: catalog(3900).products.filter((product) => product.ref !== "q-pack") });

      const res = await checkQuote(apiKey, id);
      expect(res.status).toBe(200);
      expect((await res.json()).snapshot.amount).toBe(500);
      expect(await errorCode(await postQuote(apiKey, { externalCustomerId: CUSTOMER, productRef: "q-pack" }))).toBe("unknown_product");
    });
  });

  describe("when a quote expires", () => {
    it("passes until the real time runs out, then fails, and a retry shows it as expired", { timeout: 80_000 }, async () => {
      const body = extended({ expiresInSeconds: 60 });
      const idempotencyKey = newKey();
      const created = await (await postQuote(apiKey, body, idempotencyKey)).json();
      expect(created.status).toBe("open");
      expect((await checkQuote(apiKey, created.id)).status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, Date.parse(created.expiresAt) - Date.now() + 1_000));

      const expired = await checkQuote(apiKey, created.id);
      expect(expired.status).toBe(422);
      expect(await errorCode(expired)).toBe("quote_expired");

      const retry = await postQuote(apiKey, body, idempotencyKey);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ ...created, status: "expired" });

      const another = await (await postQuote(apiKey, body)).json();
      expect(another.id).not.toBe(created.id);
      expect(another.status).toBe("open");
    });
  });
});
