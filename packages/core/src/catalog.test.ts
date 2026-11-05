import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  attributesJsonSchema,
  attributesSchema,
  catalogConfigSchema,
  findKindChanges,
  formatPrice,
  minorUnitsFromText,
  textFromMinorUnits,
  toCatalogIssues,
  type CatalogConfig,
  type CatalogField,
} from "./catalog";

const price = (amount: unknown = 900, currency: unknown = "USD") => ({ amount, currency });

const oneTime = (overrides: object = {}) => ({
  ref: "template",
  name: "Creator template",
  kind: "one_time",
  maxQuantity: 1,
  fields: [{ key: "license", label: "License", type: "enum", required: true, options: ["standard", "extended"] }],
  variants: [
    { ref: "standard-license", name: "Standard", attributes: { license: "standard" }, price: price(900), benefits: [] },
    {
      ref: "extended-license",
      name: "Extended",
      attributes: { license: "extended" },
      price: price(2900),
      benefits: [{ kind: "access", key: "commercial-use" }],
    },
  ],
  ...overrides,
});

const subscription = (overrides: object = {}) => ({
  ref: "pro",
  name: "Pro membership",
  kind: "subscription",
  fields: [],
  variants: [
    {
      ref: "monthly",
      name: "Monthly",
      price: price(1900),
      benefits: [
        { kind: "access", key: "pro" },
        { kind: "credits", amount: 2000 },
      ],
    },
  ],
  ...overrides,
});

const creditPack = (overrides: object = {}) => ({
  ref: "credits-5000",
  name: "5,000 credits",
  kind: "credit_pack",
  fields: [],
  variants: [{ ref: "default", name: "5,000 credits", price: price(500), benefits: [{ kind: "credits", amount: 5000 }] }],
  ...overrides,
});

const issuesFor = (...products: object[]) => {
  const result = catalogConfigSchema.safeParse({ products });
  return result.success ? [] : toCatalogIssues(result.error);
};

/** Fails with the full issue list, so a wrong path shows what was reported instead. */
const expectIssue = (products: object | object[], path: string) => {
  const issues = issuesFor(...[products].flat());
  expect(issues.map((issue) => issue.path)).toContain(path);
};

describe("valid catalogs", () => {
  it("accepts all three product kinds", () => {
    expect(issuesFor(oneTime(), subscription(), creditPack())).toEqual([]);
  });

  it("fills in defaults, so stored products all have the same shape", () => {
    const parsed = catalogConfigSchema.parse({ products: [creditPack()] });
    expect(parsed.products[0]!.maxQuantity).toBe(1);
    expect(parsed.products[0]!.variants[0]!.attributes).toEqual({});
  });

  it("allows a one-time variant with no benefit", () => {
    expect(issuesFor(oneTime())).toEqual([]);
  });
});

describe("prices", () => {
  it.each([
    ["a decimal", 9.5],
    ["a string", "900"],
    ["zero", 0],
    ["a negative", -1],
    ["too large", 100_000_000],
    ["null", null],
  ])("refuses %s", (_name, amount) => {
    const product = creditPack({
      variants: [{ ref: "default", name: "x", price: price(amount), benefits: [{ kind: "credits", amount: 1 }] }],
    });
    expectIssue(product, "products.0.variants.0.price.amount");
  });

  it("accepts the largest allowed price", () => {
    const product = creditPack({
      variants: [{ ref: "default", name: "x", price: price(99_999_999), benefits: [{ kind: "credits", amount: 1 }] }],
    });
    expect(issuesFor(product)).toEqual([]);
  });

  it.each(["JPY", "XXX", "usd", ""])("refuses currency %j", (currency) => {
    const product = creditPack({
      variants: [{ ref: "default", name: "x", price: price(100, currency), benefits: [{ kind: "credits", amount: 1 }] }],
    });
    expectIssue(product, "products.0.variants.0.price.currency");
  });
});

describe("refs", () => {
  it.each(["Upper", "has space", "", "__proto__", "-leading", "a".repeat(65), "dot.dot"])("refuses ref %j", (ref) => {
    expectIssue(oneTime({ ref }), "products.0.ref");
  });

  it("refuses two products with the same ref", () => {
    expectIssue([oneTime(), oneTime()], "products.1.ref");
  });

  it("allows the same variant ref in different products", () => {
    const first = creditPack();
    const second = creditPack({ ref: "credits-1000" });
    expect(issuesFor(first, second)).toEqual([]);
  });

  it("refuses two variants with the same ref in one product", () => {
    const [first, second] = oneTime().variants;
    expectIssue(oneTime({ variants: [first, { ...second, ref: first!.ref }] }), "products.0.variants.1.ref");
  });
});

describe("fields and attributes", () => {
  const withField = (field: object, attributes: object) =>
    oneTime({
      fields: [{ key: "seats", label: "Seats", ...field }],
      variants: [{ ref: "default", name: "Default", attributes, price: price(), benefits: [] }],
    });

  it.each([
    ["a value outside the enum", { type: "enum", options: ["a"] }, { seats: "b" }, "products.0.variants.0.attributes.seats"],
    ["a missing required value", { type: "text", required: true }, {}, "products.0.variants.0.attributes.seats"],
    ["an empty required text", { type: "text", required: true }, { seats: "" }, "products.0.variants.0.attributes.seats"],
    ["an unknown key", { type: "text" }, { other: "x" }, "products.0.variants.0.attributes.other"],
    ["an out-of-range integer", { type: "integer", min: 1, max: 5 }, { seats: 6 }, "products.0.variants.0.attributes.seats"],
    ["a decimal for an integer", { type: "integer" }, { seats: 1.5 }, "products.0.variants.0.attributes.seats"],
    ["an out-of-range number", { type: "number", max: 1.5 }, { seats: 1.6 }, "products.0.variants.0.attributes.seats"],
    ["too long a text", { type: "text", maxLength: 2 }, { seats: "abc" }, "products.0.variants.0.attributes.seats"],
    ["too short a text", { type: "text", minLength: 2 }, { seats: "a" }, "products.0.variants.0.attributes.seats"],
    ["a string for a boolean", { type: "boolean" }, { seats: "true" }, "products.0.variants.0.attributes.seats"],
    ["a nested value", { type: "text" }, { seats: { a: 1 } }, "products.0.variants.0.attributes.seats"],
  ])("refuses %s", (_name, field, attributes, path) => {
    expectIssue(withField(field, attributes), path);
  });

  it("accepts an optional field left out", () => {
    expect(issuesFor(withField({ type: "text" }, {}))).toEqual([]);
  });

  it("refuses identical variants, including a product with no fields", () => {
    const [first, second] = oneTime().variants;
    expectIssue(oneTime({ variants: [first, { ...second, attributes: first!.attributes }] }), "products.0.variants.1.attributes");

    const noFields = creditPack();
    const variant = noFields.variants[0]!;
    expectIssue(creditPack({ variants: [variant, { ...variant, ref: "other" }] }), "products.0.variants.1.attributes");
  });

  it("treats the same attributes in a different order as identical", () => {
    const fields = [
      { key: "a", label: "A", type: "text" },
      { key: "b", label: "B", type: "text" },
    ];
    const variant = (ref: string, attributes: object) => ({ ref, name: ref, attributes, price: price(), benefits: [] });
    const product = oneTime({ fields, variants: [variant("one", { a: "1", b: "2" }), variant("two", { b: "2", a: "1" })] });
    expectIssue(product, "products.0.variants.1.attributes");
  });

  it.each([
    ["a pattern", { type: "text", pattern: "^a$" }, "products.0.fields.0.pattern"],
    ["an unknown type", { type: "regex" }, "products.0.fields.0.type"],
    ["min above max", { type: "integer", min: 5, max: 1 }, "products.0.fields.0.min"],
    ["minLength above maxLength", { type: "text", minLength: 5, maxLength: 1 }, "products.0.fields.0.minLength"],
    ["a decimal integer limit", { type: "integer", min: 1.5 }, "products.0.fields.0.min"],
    ["an enum with no options", { type: "enum", options: [] }, "products.0.fields.0.options"],
    ["repeated options", { type: "enum", options: ["a", "a"] }, "products.0.fields.0.options"],
  ])("refuses a field with %s", (_name, field, path) => {
    expectIssue(oneTime({ fields: [{ key: "seats", label: "Seats", ...field }], variants: [] }), path);
  });

  it.each(["__proto__", "constructor", "Upper", "1st", "has-dash"])("refuses field key %j", (key) => {
    const product = oneTime({ fields: [{ key, label: "x", type: "text" }] });
    expectIssue(product, "products.0.fields.0.key");
  });

  it("refuses two fields with the same key", () => {
    const field = { key: "a", label: "A", type: "text" };
    expectIssue(oneTime({ fields: [field, field] }), "products.0.fields.1.key");
  });

  it("never stores a __proto__ attribute", () => {
    const body = `{"ref":"d","name":"D","attributes":{"__proto__":{"polluted":true}},"price":{"amount":1,"currency":"USD"},"benefits":[]}`;
    const parsed = catalogConfigSchema.parse({ products: [oneTime({ fields: [], variants: [JSON.parse(body)] })] });
    expect(JSON.stringify(parsed)).not.toContain("polluted");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("product kinds", () => {
  const packWith = (benefits: object[]) =>
    creditPack({ variants: [{ ref: "default", name: "x", price: price(), benefits }] });
  const subWith = (benefits: object[]) =>
    subscription({ variants: [{ ref: "monthly", name: "x", price: price(), benefits }] });

  it("refuses a subscription with two variants", () => {
    const variant = subscription().variants[0];
    expectIssue(subscription({ variants: [variant, { ...variant, ref: "other" }] }), "products.0.variants");
  });

  it("refuses a subscription with no access, or with two of a kind", () => {
    expectIssue(subWith([{ kind: "credits", amount: 1 }]), "products.0.variants.0.benefits");
    const access = { kind: "access", key: "pro" };
    expectIssue(subWith([access, access]), "products.0.variants.0.benefits");
    const credits = { kind: "credits", amount: 1 };
    expectIssue(subWith([access, credits, credits]), "products.0.variants.0.benefits");
  });

  it("allows a subscription with access only", () => {
    expect(issuesFor(subWith([{ kind: "access", key: "pro" }]))).toEqual([]);
  });

  it("refuses a subscription whose quantity isn't 1", () => {
    expectIssue(subscription({ maxQuantity: 2 }), "products.0.maxQuantity");
  });

  it("refuses a pack with no credits, 1.5 credits, or access", () => {
    expectIssue(packWith([]), "products.0.variants.0.benefits");
    expectIssue(packWith([{ kind: "credits", amount: 1.5 }]), "products.0.variants.0.benefits.0.amount");
    expectIssue(packWith([{ kind: "credits", amount: 0 }]), "products.0.variants.0.benefits.0.amount");
    expectIssue(packWith([{ kind: "access", key: "pro" }]), "products.0.variants.0.benefits.0.kind");
  });

  it("refuses a one-time product that grants credits or two access benefits", () => {
    const variant = (benefits: object[]) => ({ ref: "d", name: "D", price: price(), benefits });
    expectIssue(oneTime({ fields: [], variants: [variant([{ kind: "credits", amount: 5 }])] }), "products.0.variants.0.benefits.0.kind");
    const access = { kind: "access", key: "a" };
    expectIssue(oneTime({ fields: [], variants: [variant([access, access])] }), "products.0.variants.0.benefits");
  });

  it.each([0, 101, 1.5, "1"])("refuses maxQuantity %j", (maxQuantity) => {
    expectIssue(oneTime({ maxQuantity }), "products.0.maxQuantity");
    expectIssue(creditPack({ maxQuantity }), "products.0.maxQuantity");
  });

  it("refuses an unknown kind and a product with no variants", () => {
    expectIssue(oneTime({ kind: "bundle" }), "products.0.kind");
    expectIssue(oneTime({ variants: [] }), "products.0.variants");
  });
});

describe("unsupported features", () => {
  it.each(["trial", "proration", "tax", "inventory", "interval"])("refuses %s on a product", (key) => {
    expectIssue(subscription({ [key]: 1 }), `products.0.${key}`);
  });

  it("refuses unknown fields on a variant, price, benefit and the catalog", () => {
    const variant = subscription().variants[0]!;
    expectIssue(subscription({ variants: [{ ...variant, trial: 7 }] }), "products.0.variants.0.trial");
    expectIssue(subscription({ variants: [{ ...variant, price: { ...variant.price, tax: 1 } }] }), "products.0.variants.0.price.tax");
    expectIssue(
      subscription({ variants: [{ ...variant, benefits: [{ kind: "access", key: "pro", expiresIn: 1 }] }] }),
      "products.0.variants.0.benefits.0.expiresIn",
    );
    const result = catalogConfigSchema.safeParse({ products: [creditPack()], extra: true });
    expect(toCatalogIssues(result.error!).map((issue) => issue.path)).toEqual(["extra"]);
  });
});

describe("size limits", () => {
  it("refuses an empty catalog and too many products", () => {
    expect(toCatalogIssues(catalogConfigSchema.safeParse({ products: [] }).error!)[0]!.path).toBe("products");
    const products = Array.from({ length: 51 }, (_, index) => creditPack({ ref: `pack-${index}` }));
    expectIssue(products, "products");
  });

  it("accepts exactly 50 products", () => {
    const products = Array.from({ length: 50 }, (_, index) => creditPack({ ref: `pack-${index}` }));
    expect(issuesFor(...products)).toEqual([]);
  });

  it("refuses too many variants, fields and options", () => {
    const fields = [{ key: "n", label: "N", type: "integer" }];
    const variants = Array.from({ length: 21 }, (_, n) => ({
      ref: `v${n}`,
      name: `V${n}`,
      attributes: { n },
      price: price(),
      benefits: [],
    }));
    expectIssue(oneTime({ fields, variants }), "products.0.variants");

    const manyFields = Array.from({ length: 11 }, (_, n) => ({ key: `f${n}`, label: "x", type: "text" }));
    expectIssue(oneTime({ fields: manyFields, variants: [] }), "products.0.fields");

    const options = Array.from({ length: 21 }, (_, n) => `o${n}`);
    expectIssue(oneTime({ fields: [{ key: "a", label: "A", type: "enum", options }], variants: [] }), "products.0.fields.0.options");
  });
});

describe("findKindChanges", () => {
  const config = (...products: object[]) => catalogConfigSchema.parse({ products });

  it("reports an existing ref that changes kind", () => {
    const live = config(creditPack({ ref: "shared" }));
    const next = config(oneTime(), subscription({ ref: "shared" }));
    expect(findKindChanges(next, live)).toEqual([expect.objectContaining({ path: "products.1.kind" })]);
  });

  it("allows new refs, removed refs and the same kind, and any kind with nothing live", () => {
    const live: CatalogConfig = config(oneTime(), creditPack());
    expect(findKindChanges(config(oneTime(), subscription()), live)).toEqual([]);
    expect(findKindChanges(config(subscription({ ref: "template" })), null)).toEqual([]);
  });
});

describe("generated JSON Schema, checked by a separate validator", () => {
  const ajv = new Ajv2020({ strict: false });

  const FIELDS: CatalogField[] = [
    { key: "license", label: "License", type: "enum", required: true, options: ["standard", "extended"] },
    { key: "seats", label: "Seats", type: "integer", required: false, min: 1, max: 5 },
    { key: "weight", label: "Weight", type: "number", required: false, min: 0.5, max: 2.5 },
    { key: "note", label: "Note", type: "text", required: false, minLength: 2, maxLength: 4 },
    { key: "title", label: "Title", type: "text", required: false },
    { key: "printed", label: "Printed", type: "boolean", required: false },
  ];

  const REQUIRED_TEXT: CatalogField[] = [{ key: "code", label: "Code", type: "text", required: true }];

  const samples: [string, CatalogField[], unknown, boolean][] = [
    ["enum value", FIELDS, { license: "standard" }, true],
    ["all fields", FIELDS, { license: "extended", seats: 5, weight: 2.5, note: "abcd", title: "", printed: false }, true],
    ["limits at the bottom", FIELDS, { license: "standard", seats: 1, weight: 0.5, note: "ab" }, true],
    ["missing required", FIELDS, {}, false],
    ["value outside the enum", FIELDS, { license: "premium" }, false],
    ["unknown key", FIELDS, { license: "standard", colour: "red" }, false],
    ["integer too small", FIELDS, { license: "standard", seats: 0 }, false],
    ["integer too large", FIELDS, { license: "standard", seats: 6 }, false],
    ["decimal integer", FIELDS, { license: "standard", seats: 1.5 }, false],
    ["whole number for a number", FIELDS, { license: "standard", weight: 1 }, true],
    ["number too large", FIELDS, { license: "standard", weight: 2.6 }, false],
    ["text too short", FIELDS, { license: "standard", note: "a" }, false],
    ["text too long", FIELDS, { license: "standard", note: "abcde" }, false],
    ["spaces count towards length", FIELDS, { license: "standard", note: "  ab " }, false],
    ["string for a boolean", FIELDS, { license: "standard", printed: "true" }, false],
    ["string for an integer", FIELDS, { license: "standard", seats: "1" }, false],
    ["null value", FIELDS, { license: "standard", note: null }, false],
    ["array instead of an object", FIELDS, [], false],
    ["empty required text", REQUIRED_TEXT, { code: "" }, false],
    ["filled required text", REQUIRED_TEXT, { code: "a" }, true],
    ["no fields, empty attributes", [], {}, true],
    ["no fields, an extra key", [], { a: 1 }, false],
  ];

  it.each(samples)("agrees on %s", (_name, fields, value, expected) => {
    expect(attributesSchema(fields).safeParse(value).success).toBe(expected);
    expect(ajv.compile(attributesJsonSchema(fields))(value)).toBe(expected);
  });
});

describe("formatPrice", () => {
  it("shows minor units in the currency's format", () => {
    expect(formatPrice(2900, "USD")).toBe("$29.00");
    expect(formatPrice(5, "EUR")).toBe("€0.05");
    expect(formatPrice(99_999_999, "USD")).toBe("$999,999.99");
  });
});

describe("price text in the form", () => {
  it.each([
    ["29", 2900],
    ["29.9", 2990],
    ["29.90", 2990],
    ["19.99", 1999],
    ["0.07", 7],
    ["1.10", 110],
    ["999999.99", 99_999_999],
    [" 5 ", 500],
    ["0", 0],
  ])("reads %j as %d", (text, amount) => {
    expect(minorUnitsFromText(text)).toBe(amount);
  });

  it.each(["", "abc", "1.234", "-1", "1,000", ".5", "1.", "1000000", "1e3"])("refuses %j", (text) => {
    expect(minorUnitsFromText(text)).toBeNull();
  });

  it("round-trips every value it shows", () => {
    for (const amount of [1, 7, 10, 110, 1999, 2900, 99_999_999]) {
      expect(minorUnitsFromText(textFromMinorUnits(amount))).toBe(amount);
    }
  });
});
