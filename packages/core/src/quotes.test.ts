import { describe, expect, it } from "vitest";
import { catalogConfigSchema } from "./catalog";
import { buildQuoteSnapshot, parseQuoteRequest, refuseQuoteUse, type QuoteRequest } from "./quotes";

const config = catalogConfigSchema.parse({
  products: [
    {
      ref: "template",
      name: "Creator template",
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
      ref: "pro",
      name: "Pro",
      kind: "subscription",
      variants: [{ ref: "monthly", name: "Monthly", price: { amount: 1900, currency: "USD" }, benefits: [{ kind: "access", key: "pro" }] }],
    },
    {
      ref: "credits-5000",
      name: "5,000 credits",
      kind: "credit_pack",
      maxQuantity: 100,
      variants: [{ ref: "default", name: "5,000 credits", price: { amount: 500, currency: "EUR" }, benefits: [{ kind: "credits", amount: 5000 }] }],
    },
    {
      ref: "big",
      name: "Big",
      kind: "one_time",
      maxQuantity: 100,
      variants: [{ ref: "default", name: "Big", price: { amount: 99_999_999, currency: "USD" }, benefits: [] }],
    },
  ],
});
const live = { version: 4, config };

const CUSTOMER = { externalCustomerId: "app-user-42" };
const fromCatalog = (overrides: object = {}) => ({ ...CUSTOMER, productRef: "template", variantRef: "extended-license", ...overrides });
const fromMerchant = (overrides: object = {}) => ({
  ...CUSTOMER,
  item: { ref: "poster-42", name: "Poster #42" },
  unitAmount: 1500,
  currency: "USD",
  ...overrides,
});

function parsed(body: object): QuoteRequest {
  const result = parseQuoteRequest(body);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data;
}

const paths = (body: unknown) => (parseQuoteRequest(body).error?.issues ?? []).flatMap((issue) =>
  issue.code === "unrecognized_keys" ? issue.keys.map((key) => [...issue.path, key].join(".")) : [issue.path.join(".")],
);

describe("the request", () => {
  it("fills in the defaults", () => {
    expect(parsed(fromCatalog())).toMatchObject({ quantity: 1, expiresInSeconds: 1800, metadata: {} });
    expect(parsed(fromMerchant())).toMatchObject({ quantity: 1, expiresInSeconds: 1800, metadata: {}, benefits: [] });
  });

  it.each(["unitAmount", "amount", "currency", "price", "benefits", "status", "expiresAt", "catalogVersion", "snapshot", "environment", "projectId"])(
    "refuses %s on a catalog quote, because the browser could have set it",
    (field) => {
      expect(paths(fromCatalog({ [field]: 1 }))).toContain(field);
    },
  );

  it("refuses control characters in an item name, which would reach PayPal", () => {
    expect(paths(fromMerchant({ item: { ref: "a", name: "a\u0000b" } }))).toContain("item.name");
  });

  it("refuses a request mixing both forms, naming the field that doesn't belong", () => {
    expect(paths(fromMerchant({ productRef: "template" }))).toContain("productRef");
  });

  it("refuses __proto__ rather than letting it through", () => {
    expect(paths(JSON.parse(`{"externalCustomerId":"a","productRef":"template","__proto__":{"amount":1}}`))).toContain("__proto__");
  });

  it.each<[string, unknown]>([
    ["a decimal", 9.5],
    ["text", "900"],
    ["zero", 0],
    ["a negative", -1],
    ["too large", 100_000_000],
  ])("refuses %s as a merchant amount", (_name, unitAmount) => {
    expect(paths(fromMerchant({ unitAmount }))).toContain("unitAmount");
  });

  it.each(["XXX", "JPY", "usd", 840])("refuses %j as a merchant currency", (currency) => {
    expect(paths(fromMerchant({ currency }))).toContain("currency");
  });

  it("lets a merchant quote grant access, but never credits", () => {
    expect(parsed(fromMerchant({ benefits: [{ kind: "access", key: "poster" }] }))).toMatchObject({ benefits: [{ kind: "access", key: "poster" }] });
    expect(paths(fromMerchant({ benefits: [{ kind: "credits", amount: 1_000_000 }] }))).toContain("benefits.0.kind");
    expect(paths(fromMerchant({ benefits: [{ kind: "access", key: "a" }, { kind: "access", key: "b" }] }))).toContain("benefits");
  });

  it.each(["", " a", "a ", "a\nb", "a\u0000b", "a\ud800b", "x".repeat(129)])("refuses %j as a customer ID", (externalCustomerId) => {
    expect(paths(fromCatalog({ externalCustomerId }))).toContain("externalCustomerId");
  });

  it.each(["a", "Bob", "user@example.com", "x y", "ユーザー", "x".repeat(128)])("accepts %j as a customer ID, exactly", (externalCustomerId) => {
    expect(parsed(fromCatalog({ externalCustomerId }))).toMatchObject({ externalCustomerId });
  });

  it.each<[string, number]>([
    ["too short", 59],
    ["too long", 3601],
    ["not whole", 90.5],
  ])("refuses an expiry that's %s", (_name, expiresInSeconds) => {
    expect(paths(fromCatalog({ expiresInSeconds }))).toContain("expiresInSeconds");
  });

  it.each([60, 3600])("accepts an expiry of %d seconds", (expiresInSeconds) => {
    expect(parsed(fromCatalog({ expiresInSeconds }))).toMatchObject({ expiresInSeconds });
  });

  it.each<[string, unknown]>([
    ["0", 0],
    ["101", 101],
    ["1.5", 1.5],
    ["text", "1"],
  ])("refuses a quantity of %s", (_name, quantity) => {
    expect(paths(fromCatalog({ quantity }))).toContain("quantity");
  });

  it("limits metadata", () => {
    expect(paths(fromCatalog({ metadata: { order: 1 } }))).toContain("metadata.order");
    expect(paths(fromCatalog({ metadata: { order: "x".repeat(501) } }))).toContain("metadata.order");
    expect(paths(fromCatalog({ metadata: { order: "a\u0000" } }))).toContain("metadata.order");
    expect(paths(fromCatalog({ metadata: { "1bad": "a" } }))).toContain("metadata.1bad");
    expect(paths(fromCatalog({ metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"])) }))).toContain("metadata");
    expect(parsed(fromCatalog({ metadata: { orderId: "A-1009", "cart_ref": "" } }))).toMatchObject({ metadata: { orderId: "A-1009", cart_ref: "" } });
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an array", []],
    ["text", "x"],
    ["nothing", undefined],
  ])("refuses %s as a body", (_name, body) => {
    expect(parseQuoteRequest(body).success).toBe(false);
  });
});

describe("the price, from the live catalog", () => {
  it("takes the price, benefits and version from the catalog", () => {
    expect(buildQuoteSnapshot(parsed(fromCatalog({ metadata: { order: "A" } })), live)).toEqual({
      snapshot: {
        source: "catalog",
        catalogVersion: 4,
        product: { ref: "template", name: "Creator template", kind: "one_time" },
        variant: { ref: "extended-license", name: "Extended", attributes: { license: "extended" } },
        quantity: 1,
        unitAmount: 2900,
        amount: 2900,
        currency: "USD",
        benefits: [{ kind: "access", key: "commercial-use" }],
        metadata: { order: "A" },
      },
    });
  });

  it("multiplies the total and keeps benefits per unit", () => {
    const built = buildQuoteSnapshot(parsed({ ...CUSTOMER, productRef: "credits-5000", quantity: 2 }), live);
    expect(built).toMatchObject({
      snapshot: { quantity: 2, unitAmount: 500, amount: 1000, currency: "EUR", benefits: [{ kind: "credits", amount: 5000 }] },
    });
  });

  it("lets variantRef be left out only when there's one variant", () => {
    expect(buildQuoteSnapshot(parsed({ ...CUSTOMER, productRef: "credits-5000" }), live)).toMatchObject({ snapshot: { variant: { ref: "default" } } });
    expect(buildQuoteSnapshot(parsed({ ...CUSTOMER, productRef: "template" }), live)).toMatchObject({ refusal: { code: "variant_required" } });
  });

  it.each<[string, object, string]>([
    ["an unknown product", { productRef: "nope", variantRef: undefined }, "unknown_product"],
    ["an unknown variant", { variantRef: "nope" }, "unknown_variant"],
    ["a subscription", { productRef: "pro", variantRef: undefined }, "not_quotable"],
    ["more than maxQuantity", { quantity: 2 }, "quantity_too_large"],
    ["a total over the limit", { productRef: "big", variantRef: undefined, quantity: 2 }, "amount_too_large"],
  ])("refuses %s", (_name, overrides, code) => {
    expect(buildQuoteSnapshot(parsed(fromCatalog(overrides)), live)).toMatchObject({ refusal: { code } });
  });

  it("refuses when nothing is live", () => {
    expect(buildQuoteSnapshot(parsed(fromCatalog()), null)).toMatchObject({ refusal: { code: "no_live_catalog" } });
  });
});

describe("the price, from the merchant", () => {
  it("uses the sent price, with no catalog version", () => {
    expect(buildQuoteSnapshot(parsed(fromMerchant({ quantity: 3, benefits: [{ kind: "access", key: "poster" }] })), live)).toEqual({
      snapshot: {
        source: "merchant",
        catalogVersion: null,
        product: { ref: "poster-42", name: "Poster #42", kind: "one_time" },
        variant: null,
        quantity: 3,
        unitAmount: 1500,
        amount: 4500,
        currency: "USD",
        benefits: [{ kind: "access", key: "poster" }],
        metadata: {},
      },
    });
  });

  it("works with nothing live", () => {
    expect(buildQuoteSnapshot(parsed(fromMerchant()), null)).toHaveProperty("snapshot");
  });

  it("can't undercut a catalog price", () => {
    const body = fromMerchant({ item: { ref: "template", name: "Cheap" }, unitAmount: 1 });
    expect(buildQuoteSnapshot(parsed(body), live)).toMatchObject({ refusal: { code: "product_in_catalog" } });
  });

  it("refuses a total over the limit, at exactly one above it", () => {
    expect(buildQuoteSnapshot(parsed(fromMerchant({ unitAmount: 99_999_999 })), null)).toHaveProperty("snapshot");
    expect(buildQuoteSnapshot(parsed(fromMerchant({ unitAmount: 50_000_000, quantity: 2 })), null)).toMatchObject({ refusal: { code: "amount_too_large" } });
  });
});

describe("using a stored quote", () => {
  const open = { externalCustomerId: "app-user-42", isExpired: false };

  it("allows its own customer while it's open", () => {
    expect(refuseQuoteUse(open, "app-user-42")).toBeNull();
  });

  it.each(["app-user-43", "APP-USER-42", "app-user-42 "])("refuses %j", (customer) => {
    expect(refuseQuoteUse(open, customer)).toMatchObject({ code: "quote_customer_mismatch" });
  });

  it("refuses once it has expired", () => {
    expect(refuseQuoteUse({ ...open, isExpired: true }, "app-user-42")).toMatchObject({ code: "quote_expired" });
  });
});
