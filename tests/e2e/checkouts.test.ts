// Runs against a live stack (see README). Every check goes through HTTP, like a real caller. The second block creates keys, catalog
// versions and checkouts and makes real, unapproved PayPal sandbox orders, so run it only against a throwaway database.
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const CHECKOUTS = "/v1/checkouts";
const QUOTES = "/v1/quotes";
const KEYS = "/admin/developers/api-keys";
const ORIGINS = "/admin/developers/return-origins";
const DRAFTS = "/admin/config/drafts";
const UNKNOWN_ID = "01900000-0000-7000-8000-000000000000";
const RATE_LIMIT_WINDOW_MS = 11_000;
const RETURN_ORIGIN = "https://merchant.example.com";
const RETURN_URL = `${RETURN_ORIGIN}/billing/return`;
const CUSTOMER = "app-user-secret-42";
const METADATA_VALUE = "metadata-secret-value";

describe("hosted routes without a checkout", () => {
  it.each(["pay", "confirm"])("POST %s on an unknown or malformed ID returns 404", async (step) => {
    for (const id of [UNKNOWN_ID, "not-a-uuid", "'; DROP TABLE checkout; --"]) {
      const res = await fetch(`${BASE_URL}/checkout/${encodeURIComponent(id)}/${step}`, { method: "POST" });
      expect(res.status).toBe(404);
    }
  });

  it.each(["", "/return"])("the page %s on an unknown ID returns 404", async (suffix) => {
    expect((await fetch(`${BASE_URL}/checkout/${UNKNOWN_ID}${suffix}`)).status).toBe(404);
  });

  it("a GET can't start a payment: only POST exists", async () => {
    expect((await fetch(`${BASE_URL}/checkout/${UNKNOWN_ID}/pay`)).status).toBe(405);
    expect((await fetch(`${BASE_URL}/checkout/${UNKNOWN_ID}/confirm`)).status).toBe(405);
  });

  it("an event for an unknown connection returns 404", async () => {
    for (const id of [UNKNOWN_ID, "m00"]) {
      const res = await fetch(`${BASE_URL}/webhooks/paypal/${id}`, { method: "POST", body: "{}" });
      expect(res.status).toBe(404);
    }
  });
});

describe.runIf(process.env.E2E_WRITE_DB === "1" && process.env.E2E_PAYPAL === "1")("with a key and real PayPal", { timeout: 60_000 }, () => {
  let cookie: string;
  let apiKey: string;
  let connectionId: string;
  let keyNumber = 0;

  const newKey = () => `e2e-checkout-${Date.now()}-${keyNumber++}`;

  const admin = (path: string, init: RequestInit = {}) =>
    fetch(`${BASE_URL}${path}`, {
      redirect: "manual",
      ...init,
      headers: { Cookie: cookie, Origin: BASE_URL, "Content-Type": "application/json", ...init.headers },
    });

  const send = (path: string, body: unknown, idempotencyKey: string | null = newKey()) =>
    fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }) },
      body: JSON.stringify(body),
    });

  const errorCode = async (res: Response) => (await res.json()).error.code as string;

  const fromCatalog = (overrides: object = {}) => ({
    externalCustomerId: CUSTOMER,
    productRef: "c-template",
    variantRef: "extended-license",
    returnUrl: RETURN_URL,
    metadata: { note: METADATA_VALUE },
    ...overrides,
  });

  const newQuote = async (overrides: object = {}) => {
    const res = await send(QUOTES, { externalCustomerId: CUSTOMER, item: { ref: "poster-42", name: "Poster #42" }, unitAmount: 1500, currency: "USD", ...overrides });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };

  const newCheckout = async (overrides: object = {}) => {
    const res = await send(CHECKOUTS, fromCatalog(overrides));
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; checkoutUrl: string; money: string; paypal: { orderId: string | null } };
  };

  const status = async (id: string) =>
    (await (await fetch(`${BASE_URL}${CHECKOUTS}/${id}`, { headers: { Authorization: `Bearer ${apiKey}` } })).json()) as {
      money: string;
      nextAction: string;
      paypal: { orderId: string | null; captureId: string | null };
      snapshot: { amount: number };
    };

  beforeAll(async () => {
    const attempt = () =>
      fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL },
        body: JSON.stringify({ email: process.env.OPERATOR_EMAIL, password: process.env.OPERATOR_PASSWORD }),
      });
    let signedIn = await attempt();
    if (signedIn.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WINDOW_MS));
      signedIn = await attempt();
    }
    expect(signedIn.status).toBe(200);
    cookie = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.includes("session_token"))!;

    const key = await admin(KEYS, { method: "POST", body: JSON.stringify({ name: "e2e checkouts" }) });
    apiKey = ((await key.json()) as { key: string }).key;

    const versions = (await (await admin(DRAFTS)).json()).versions as { version: number }[];
    const saved = await admin(DRAFTS, {
      method: "POST",
      body: JSON.stringify({
        baseVersion: versions[0]?.version ?? 0,
        config: {
          products: [
            {
              ref: "c-template",
              name: "Creator <b>template</b>",
              kind: "one_time",
              fields: [{ key: "license", label: "License", type: "enum", required: true, options: ["standard", "extended"] }],
              variants: [
                { ref: "standard-license", name: "Standard", attributes: { license: "standard" }, price: { amount: 900, currency: "USD" }, benefits: [] },
                {
                  ref: "extended-license",
                  name: "Extended",
                  attributes: { license: "extended" },
                  price: { amount: 2900, currency: "USD" },
                  benefits: [{ kind: "access", key: "commercial-use" }],
                },
              ],
            },
            {
              ref: "c-pro",
              name: "Pro",
              kind: "subscription",
              variants: [{ ref: "monthly", name: "Monthly", price: { amount: 1900, currency: "USD" }, benefits: [{ kind: "access", key: "pro" }] }],
            },
          ],
        },
      }),
    });
    const { id: versionId } = (await saved.json()) as { id: string };
    expect((await admin(`${DRAFTS}/${versionId}/activate`, { method: "POST" })).status).toBe(200);

    const connected = await admin("/admin/paypal/connections/sandbox", {
      method: "PUT",
      body: JSON.stringify({ clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET }),
    });
    expect(connected.status).toBe(200);
    connectionId = new URL(((await connected.json()) as { webhook: { url: string } }).webhook.url).pathname.split("/").pop()!;
  }, 60_000);

  describe("allowed return URLs", () => {
    it("refuses a checkout before its origin is allowed, and stores nothing", async () => {
      const key = newKey();
      const res = await send(CHECKOUTS, fromCatalog({ returnUrl: "https://not-yet.example.com/x" }), key);
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe("return_url_not_allowed");
      // The same key still works, which only holds if nothing was stored.
      expect((await admin(ORIGINS, { method: "POST", body: JSON.stringify({ origin: RETURN_ORIGIN }) })).status).toBe(201);
      expect((await send(CHECKOUTS, fromCatalog(), key)).status).toBe(201);
    });

    it("adding one twice lists it once, and removing it stops new checkouts", async () => {
      const origin = "https://removable.example.com";
      await admin(ORIGINS, { method: "POST", body: JSON.stringify({ origin }) });
      await admin(ORIGINS, { method: "POST", body: JSON.stringify({ origin }) });
      const listed = ((await (await admin(ORIGINS)).json()) as { origins: { id: string; origin: string }[] }).origins.filter((row) => row.origin === origin);
      expect(listed).toHaveLength(1);
      expect((await send(CHECKOUTS, fromCatalog({ returnUrl: `${origin}/x` }))).status).toBe(201);

      expect((await admin(`${ORIGINS}/${listed[0]!.id}`, { method: "DELETE" })).status).toBe(200);
      expect((await admin(`${ORIGINS}/${listed[0]!.id}`, { method: "DELETE" })).status).toBe(200);
      expect((await send(CHECKOUTS, fromCatalog({ returnUrl: `${origin}/x` }))).status).toBe(422);
    });

    it.each(["https://merchant.example.com.evil.test/x", "https://evil.test/https://merchant.example.com", "https://merchant.example.com:8443/x"])(
      "refuses the lookalike %s",
      async (returnUrl) => {
        expect(await errorCode(await send(CHECKOUTS, fromCatalog({ returnUrl })))).toBe("return_url_not_allowed");
      },
    );

    it.each(["javascript:alert(1)", "http://merchant.example.com/x", "https://user:pw@merchant.example.com/x"])("refuses %s as invalid", async (returnUrl) => {
      const res = await send(CHECKOUTS, fromCatalog({ returnUrl }));
      expect(res.status).toBe(400);
      expect(((await res.json()).error.details.fields as { path: string }[])[0]!.path).toBe("returnUrl");
    });

    it("refuses another origin when adding: no paths, no plain http", async () => {
      for (const origin of ["https://merchant.example.com/path", "http://merchant.example.com", "*"]) {
        expect((await admin(ORIGINS, { method: "POST", body: JSON.stringify({ origin }) })).status).toBe(400);
      }
    });
  });

  describe("starting a checkout", () => {
    it("needs an Idempotency-Key", async () => {
      expect(await errorCode(await send(CHECKOUTS, fromCatalog(), null))).toBe("idempotency_key_required");
    });

    it("takes the price from the live catalog and shows it as pending", async () => {
      const res = await send(CHECKOUTS, fromCatalog());
      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const body = await res.json();
      expect(body).toMatchObject({
        externalCustomerId: CUSTOMER,
        money: "pending",
        fulfillment: "pending",
        nextAction: "redirect",
        paypal: { orderId: null, captureId: null },
      });
      // Nothing has happened to it yet, so it's in no destination; which word depends on whether one is set up.
      expect(["not_configured", "pending"]).toContain(body.sync);
      expect(body.snapshot).toMatchObject({ source: "catalog", unitAmount: 2900, amount: 2900, currency: "USD", metadata: { note: METADATA_VALUE } });
      expect(new URL(body.checkoutUrl).pathname).toBe(`/checkout/${body.id}`);
      expect(new URL(body.checkoutUrl).origin).toBe(new URL(process.env.PUBLIC_BASE_URL!).origin);
    });

    it("builds checkoutUrl from config, never the Host header", async () => {
      const res = await fetch(`${BASE_URL}${CHECKOUTS}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": newKey(), "X-Forwarded-Host": "evil.test" },
        body: JSON.stringify(fromCatalog()),
      });
      expect((await res.json()).checkoutUrl).not.toContain("evil.test");
    });

    it.each(["unitAmount", "amount", "currency", "benefits", "money", "status", "expiresAt", "paypalOrderId"])("refuses a tampered %s", async (field) => {
      const res = await send(CHECKOUTS, { ...fromCatalog(), [field]: 1 });
      expect(res.status).toBe(400);
    });

    it.each<[object, string]>([
      [{ productRef: "nope", variantRef: undefined }, "unknown_product"],
      [{ variantRef: "nope" }, "unknown_variant"],
      [{ variantRef: undefined }, "variant_required"],
      [{ quantity: 2 }, "quantity_too_large"],
    ])("refuses %j", async (overrides, code) => {
      const res = await send(CHECKOUTS, fromCatalog(overrides));
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe(code);
    });

    it("a retry returns the same checkout, and a different body returns 409", async () => {
      const key = newKey();
      const first = await send(CHECKOUTS, fromCatalog(), key);
      const again = await send(CHECKOUTS, fromCatalog(), key);
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect((await again.json()).id).toBe((await first.json()).id);

      const other = await send(CHECKOUTS, fromCatalog({ variantRef: "standard-license" }), key);
      expect(other.status).toBe(409);
      expect(await errorCode(other)).toBe("idempotency_conflict");
    });

    it("20 at once with one key make one checkout", async () => {
      const key = newKey();
      const answers = await Promise.all(Array.from({ length: 20 }, () => send(CHECKOUTS, fromCatalog(), key)));
      expect(answers.filter((res) => res.status === 201)).toHaveLength(1);
      expect(answers.filter((res) => res.status === 200)).toHaveLength(19);
      const ids = new Set(await Promise.all(answers.map(async (res) => (await res.json()).id)));
      expect(ids.size).toBe(1);
    });
  });

  describe("from a quote", () => {
    const fromQuote = (quoteId: string, overrides: object = {}) => ({ externalCustomerId: CUSTOMER, quoteId, returnUrl: RETURN_URL, ...overrides });

    it("copies the quote's exact snapshot", async () => {
      const quote = await (await send(QUOTES, { externalCustomerId: CUSTOMER, item: { ref: "poster-1", name: "Poster" }, unitAmount: 1234, currency: "USD", quantity: 3 })).json();
      const checkout = await (await send(CHECKOUTS, fromQuote(quote.id))).json();
      expect(checkout.snapshot).toEqual(quote.snapshot);
      expect(checkout.snapshot.amount).toBe(3702);
    });

    it("one quote gets one checkout, and the second is told which", async () => {
      const quote = await newQuote();
      const first = await (await send(CHECKOUTS, fromQuote(quote.id))).json();
      const second = await send(CHECKOUTS, fromQuote(quote.id));
      expect(second.status).toBe(409);
      const { error } = await second.json();
      expect(error.code).toBe("quote_used");
      expect(error.details.checkoutId).toBe(first.id);
    });

    it("20 at once for one quote, with different keys, make one checkout and no 500s", async () => {
      const quote = await newQuote();
      const answers = await Promise.all(Array.from({ length: 20 }, () => send(CHECKOUTS, fromQuote(quote.id))));
      expect(answers.map((res) => res.status).sort()).toEqual([201, ...Array<number>(19).fill(409)]);
    });

    it("refuses another customer and an unknown quote", async () => {
      const quote = await newQuote();
      expect(await errorCode(await send(CHECKOUTS, fromQuote(quote.id, { externalCustomerId: "someone-else" })))).toBe("quote_customer_mismatch");
      expect((await send(CHECKOUTS, fromQuote(UNKNOWN_ID))).status).toBe(404);
    });
  });

  describe("the hosted page", () => {
    it("shows the item and total, and nothing private, with markup as plain text", async () => {
      const { id } = await newCheckout();
      for (const path of [`/checkout/${id}`, `/checkout/${id}/return`]) {
        const res = await fetch(`${BASE_URL}${path}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toContain("no-store");
        const html = await res.text();
        expect(html).toContain("$29.00");
        expect(html).toContain("Extended");
        expect(html).toContain("noindex");
        expect(html).not.toContain(CUSTOMER);
        expect(html).not.toContain(METADATA_VALUE);
        expect(html).not.toContain("commercial-use");
        expect(html).not.toContain("<b>template</b>");
      }
    });

    it("a browser's own state can't move it: a forged return changes nothing and makes no capture", async () => {
      const { id } = await newCheckout();
      const pay = await (await fetch(`${BASE_URL}/checkout/${id}/pay`, { method: "POST" })).json();
      const forged = await fetch(`${BASE_URL}/checkout/${id}/return?token=FORGED&PayerID=FORGED`);
      expect(forged.status).toBe(200);
      const confirm = await fetch(`${BASE_URL}/checkout/${id}/confirm?token=FORGED&PayerID=FORGED`, { method: "POST" });
      expect(confirm.status).toBe(200);
      expect(await confirm.json()).toMatchObject({ money: "pending", nextAction: "redirect" });

      const after = await status(id);
      expect(after).toMatchObject({ money: "pending", paypal: { captureId: null } });
      expect(pay.approvalUrl).toContain(after.paypal.orderId);
    });
  });

  describe("subscriptions", () => {
    const subscriptionFor = (customer: string) => fromCatalog({ externalCustomerId: customer, productRef: "c-pro", variantRef: "monthly", metadata: {} });

    it("a subscription starts from the live catalog; a second one for the same customer is refused", async () => {
      const customer = `sub-${newKey()}`;
      const first = await send(CHECKOUTS, subscriptionFor(customer));
      expect(first.status).toBe(201);
      const body = await first.json();
      expect(body.snapshot.product).toMatchObject({ ref: "c-pro", kind: "subscription" });
      expect(body.subscription).toBeNull();

      const second = await send(CHECKOUTS, subscriptionFor(customer));
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error: { code: "subscription_exists", details: { checkoutId: body.id } } });
      expect((await send(CHECKOUTS, subscriptionFor(`other-${customer}`))).status).toBe(201);
    });

    it("a quote still can't hold a subscription", async () => {
      const res = await send(QUOTES, { externalCustomerId: CUSTOMER, productRef: "c-pro", variantRef: "monthly" });
      expect(res.status).toBe(422);
      expect(await errorCode(res)).toBe("not_quotable");
    });

    it("Pay makes one real PayPal subscription on a monthly plan, and clicking again reuses it", async () => {
      const created = await (await send(CHECKOUTS, subscriptionFor(`sub-pay-${newKey()}`))).json();
      const pay = () => fetch(`${BASE_URL}/checkout/${created.id}/pay`, { method: "POST" });
      const first = await (await pay()).json();
      expect(new URL(first.approvalUrl).hostname).toMatch(/sandbox\.paypal\.com$/);
      const subscription = (await status(created.id)).subscription;
      expect(subscription).toMatchObject({ status: "pending", paidThrough: null, accessUntil: null, cancelRequested: false });

      const again = await (await pay()).json();
      expect(again.approvalUrl).toBe(first.approvalUrl);
      expect((await status(created.id)).subscription.id).toBe(subscription.id);
    });

    it("cancelling before the buyer approves is refused, and an unknown one is 404", async () => {
      const created = await (await send(CHECKOUTS, subscriptionFor(`sub-cancel-${newKey()}`))).json();
      await fetch(`${BASE_URL}/checkout/${created.id}/pay`, { method: "POST" });
      const { id } = (await status(created.id)).subscription;
      const cancel = (subscriptionId: string) => send(`/v1/subscriptions/${subscriptionId}/cancel`, {}, null);
      expect((await cancel(id)).status).toBe(409);
      expect((await cancel("00000000-0000-7000-8000-000000000000")).status).toBe(404);
    });
  });

  describe("paying", () => {
    it("makes one real PayPal order, and clicking again reuses it", async () => {
      const { id } = await newCheckout();
      const pay = () => fetch(`${BASE_URL}/checkout/${id}/pay`, { method: "POST" });
      const first = await (await pay()).json();
      expect(new URL(first.approvalUrl).hostname).toMatch(/sandbox\.paypal\.com$/);
      const stored = (await status(id)).paypal.orderId;
      expect(stored).toBeTruthy();

      const again = await (await pay()).json();
      expect(again.approvalUrl).toContain(stored);
      expect((await status(id)).paypal.orderId).toBe(stored);
    });

    it("20 clicks at once make one order, and past 10 a minute the rest are told to wait", async () => {
      const { id } = await newCheckout();
      const answers = await Promise.all(Array.from({ length: 20 }, () => fetch(`${BASE_URL}/checkout/${id}/pay`, { method: "POST" })));
      const bodies = await Promise.all(answers.map((res) => res.json() as Promise<{ approvalUrl?: string; error?: { code: string } }>));
      const stored = (await status(id)).paypal.orderId!;
      expect(answers.map((res) => res.status).sort()).toEqual([...Array(10).fill(200), ...Array(10).fill(429)]);
      for (const [index, body] of bodies.entries()) {
        if (answers[index]!.status === 200) expect(body.approvalUrl).toContain(stored);
        else expect(body.error?.code).toBe("rate_limited");
      }
    });
  });

  describe("webhooks", () => {
    const hook = (body: string, headers: Record<string, string> = {}) => fetch(`${BASE_URL}/webhooks/paypal/${connectionId}`, { method: "POST", headers, body });
    const signed = {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270",
      "paypal-transmission-id": "00000000-0000-0000-0000-000000000000",
      "paypal-transmission-sig": "Zm9yZ2Vk",
      "paypal-transmission-time": "2026-11-05T00:00:00Z",
    };
    const event = JSON.stringify({ id: "WH-FORGED", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "FORGED" } });

    it("refuses an event with no signature headers, without asking PayPal", async () => {
      const res = await hook(event);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("not_verified");
    });

    it.each(["not json", "[]", "{}", '{"id":"x"}', '{"event_type":"x"}'])("refuses the body %s", async (body) => {
      expect((await hook(body, signed)).status).toBe(400);
    });

    it("refuses a forged signature, checked by real PayPal", async () => {
      const res = await hook(event, signed);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("not_verified");
    });

    it("refuses an oversized event", async () => {
      const res = await hook(JSON.stringify({ id: "x", event_type: "y", padding: "z".repeat(300 * 1024) }), signed);
      expect(res.status).toBe(413);
    });
  });
});
