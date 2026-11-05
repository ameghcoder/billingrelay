// Runs against a live stack (see README). The E2E_WRITE_DB block saves catalog versions, so run it only
// against a throwaway database. Everything above it is refused before anything is stored.
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const DRAFTS = "/admin/config/drafts";
const UNKNOWN_ID = "01900000-0000-7000-8000-000000000000";

let cookie: string;

const send = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE_URL}${path}`, {
    redirect: "manual",
    ...init,
    headers: { Cookie: cookie, Origin: BASE_URL, "Content-Type": "application/json", ...init.headers },
  });

const save = (body: unknown, init: RequestInit = {}) => send(DRAFTS, { method: "POST", body: JSON.stringify(body), ...init });
const activate = (id: string) => send(`${DRAFTS}/${id}/activate`, { method: "POST" });
const readVersions = async () => (await (await send(DRAFTS)).json()).versions as { id: string; version: number; isLive: boolean }[];

const price = (amount: unknown = 900, currency: unknown = "USD") => ({ amount, currency });

const template = (overrides: object = {}) => ({
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

const pro = (overrides: object = {}) => ({
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

const pack = (overrides: object = {}) => ({
  ref: "credits-5000",
  name: "5,000 credits",
  kind: "credit_pack",
  fields: [],
  variants: [{ ref: "default", name: "5,000 credits", price: price(500), benefits: [{ kind: "credits", amount: 5000 }] }],
  ...overrides,
});

const catalog = (...products: object[]) => ({ products });
const packWithPrice = (amount: unknown, currency: unknown = "USD") =>
  pack({ variants: [{ ref: "default", name: "x", price: price(amount, currency), benefits: [{ kind: "credits", amount: 1 }] }] });
const withField = (field: object, attributes: object) =>
  template({
    fields: [{ key: "seats", label: "Seats", ...field }],
    variants: [{ ref: "default", name: "D", attributes, price: price(), benefits: [] }],
  });

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

describe("requests refused before anything is stored", () => {
  const P = "config.products.0";

  it.each<[string, object, string]>([
    ["a decimal price", packWithPrice(9.5), `${P}.variants.0.price.amount`],
    ["a string price", packWithPrice("900"), `${P}.variants.0.price.amount`],
    ["a zero price", packWithPrice(0), `${P}.variants.0.price.amount`],
    ["a negative price", packWithPrice(-1), `${P}.variants.0.price.amount`],
    ["too large a price", packWithPrice(100_000_000), `${P}.variants.0.price.amount`],
    ["an unknown currency", packWithPrice(100, "XXX"), `${P}.variants.0.price.currency`],
    ["a zero-decimal currency", packWithPrice(100, "JPY"), `${P}.variants.0.price.currency`],
    ["a value outside the enum", withField({ type: "enum", options: ["a"] }, { seats: "b" }), `${P}.variants.0.attributes.seats`],
    ["a missing required value", withField({ type: "text", required: true }, {}), `${P}.variants.0.attributes.seats`],
    ["an unknown attribute", withField({ type: "text" }, { other: "x" }), `${P}.variants.0.attributes.other`],
    ["an out-of-range attribute", withField({ type: "integer", max: 5 }, { seats: 6 }), `${P}.variants.0.attributes.seats`],
    ["too long an attribute", withField({ type: "text", maxLength: 1 }, { seats: "ab" }), `${P}.variants.0.attributes.seats`],
    [
      "identical variants",
      template({ variants: [template().variants[0], { ...template().variants[1], attributes: { license: "standard" } }] }),
      `${P}.variants.1.attributes`,
    ],
    ["a subscription with two variants", pro({ variants: [pro().variants[0], { ...pro().variants[0], ref: "b" }] }), `${P}.variants`],
    [
      "a subscription with no access",
      pro({ variants: [{ ...pro().variants[0], benefits: [{ kind: "credits", amount: 1 }] }] }),
      `${P}.variants.0.benefits`,
    ],
    ["a pack with no credits", pack({ variants: [{ ...pack().variants[0], benefits: [] }] }), `${P}.variants.0.benefits`],
    [
      "a pack with 1.5 credits",
      pack({ variants: [{ ...pack().variants[0], benefits: [{ kind: "credits", amount: 1.5 }] }] }),
      `${P}.variants.0.benefits.0.amount`,
    ],
    [
      "a one-time product with credits",
      template({ variants: [{ ...template().variants[1], benefits: [{ kind: "credits", amount: 1 }] }] }),
      `${P}.variants.0.benefits.0.kind`,
    ],
    ["a trial", pro({ trial: 7 }), `${P}.trial`],
    ["a field pattern", template({ fields: [{ key: "a", label: "A", type: "text", pattern: ".*" }], variants: [] }), `${P}.fields.0.pattern`],
  ])("refuses %s and names the field", async (_name, product, path) => {
    const before = await readVersions();
    const res = await save({ baseVersion: before[0]?.version ?? 0, config: catalog(product) });
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const { error } = await res.json();
    expect(error.code).toBe("invalid_config");
    expect(error.details.fields.map((field: { path: string }) => field.path)).toContain(path);
    expect(await readVersions()).toEqual(before);
  });

  it.each<[string, string]>([
    ["no body", ""],
    ["broken JSON", "{not json"],
    ["null", "null"],
    ["an array", "[]"],
  ])("refuses %s", async (_name, body) => {
    const res = await send(DRAFTS, { method: "POST", body });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_config");
  });

  it.each([
    ["no baseVersion", { config: catalog(pack()) }],
    ["a negative baseVersion", { baseVersion: -1, config: catalog(pack()) }],
    ["an extra top-level field", { baseVersion: 0, config: catalog(pack()), force: true }],
  ])("refuses %s", async (_name, body) => {
    const res = await save(body);
    expect(res.status).toBe(400);
  });

  it.each([
    ["another site", { Origin: "https://evil.example" }],
    ["a look-alike origin", { Origin: `${BASE_URL}.evil.example` }],
  ])("refuses a signed-in save from %s", async (_name, headers) => {
    const res = await save({ baseVersion: 0, config: catalog(pack()) }, { headers });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_origin");
  });

  it("refuses a signed-in save with no Origin header", async () => {
    const res = await fetch(`${BASE_URL}${DRAFTS}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ baseVersion: 0, config: catalog(pack()) }),
    });
    expect(res.status).toBe(403);
  });

  it.each(["not-a-uuid", UNKNOWN_ID, "' OR 1=1 --"])("returns 404 for version %j", async (id) => {
    const path = encodeURIComponent(id);
    expect((await send(`${DRAFTS}/${path}`)).status).toBe(404);
    expect((await activate(path)).status).toBe(404);
  });
});

describe.runIf(process.env.E2E_WRITE_DB === "1")("saved versions", () => {
  let v1: { id: string; version: number };
  let v2: { id: string; version: number };
  let v1Text: string;

  const readLive = async () => (await readVersions()).filter((version) => version.isLive).map((version) => version.version);

  it("saves all three kinds as a new version, without changing what's live", async () => {
    const latest = (await readVersions())[0]?.version ?? 0;
    const liveBefore = await readLive();
    const res = await save({ baseVersion: latest, config: catalog(template(), pro(), pack()) });
    expect(res.status).toBe(201);
    v1 = await res.json();
    expect(v1.version).toBe(latest + 1);
    expect(await readLive()).toEqual(liveBefore);
  });

  it("shows the stored config and a JSON Schema for each product", async () => {
    const res = await send(`${DRAFTS}/${v1.id}`);
    expect(res.status).toBe(200);
    v1Text = await res.text();
    const detail = JSON.parse(v1Text);
    expect(detail.config.products.map((product: { ref: string }) => product.ref)).toEqual(["template", "pro", "credits-5000"]);
    expect(detail.config.products[0].variants[1].price).toEqual({ amount: 2900, currency: "USD" });
    const schema = detail.attributeSchemas.find((entry: { productRef: string }) => entry.productRef === "template").schema;
    expect(schema.properties.license.enum).toEqual(["standard", "extended"]);
    expect(schema.required).toEqual(["license"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("refuses a stale baseVersion and stores nothing", async () => {
    const res = await save({ baseVersion: v1.version - 1, config: catalog(pack()) });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.code).toBe("version_conflict");
    expect(error.details.latestVersion).toBe(v1.version);
    expect((await readVersions())[0]!.version).toBe(v1.version);
  });

  it("lets exactly one of many saves at the same moment win", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => save({ baseVersion: v1.version, config: catalog(template(), pro()) })),
    );
    const statuses = responses.map((res) => res.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(19);
    const versions = await readVersions();
    expect(versions[0]!.version).toBe(v1.version + 1);
    v2 = { id: versions[0]!.id, version: versions[0]!.version };
  });

  it("leaves an older version unchanged, byte for byte", async () => {
    expect(await (await send(`${DRAFTS}/${v1.id}`)).text()).toBe(v1Text);
  });

  it.each(["PUT", "PATCH", "DELETE"])("has no %s route for a version", async (method) => {
    const res = await send(`${DRAFTS}/${v1.id}`, { method, body: JSON.stringify({ config: catalog(pack()) }) });
    expect(res.status).toBe(405);
    expect(await (await send(`${DRAFTS}/${v1.id}`)).text()).toBe(v1Text);
  });

  it("moves the live pointer to whichever version is activated", async () => {
    expect((await activate(v2.id)).status).toBe(200);
    expect(await readLive()).toEqual([v2.version]);
    const res = await activate(v1.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: v1.id, version: v1.version, isLive: true });
    expect(await readLive()).toEqual([v1.version]);
  });

  it("activating the live version again changes nothing", async () => {
    expect((await activate(v1.id)).status).toBe(200);
    expect(await readLive()).toEqual([v1.version]);
  });

  it("keeps the live version when an unknown one is activated", async () => {
    expect((await activate(UNKNOWN_ID)).status).toBe(404);
    expect(await readLive()).toEqual([v1.version]);
  });

  it("refuses to save an existing ref as a different kind", async () => {
    const latest = (await readVersions())[0]!.version;
    const res = await save({ baseVersion: latest, config: catalog(pack({ ref: "template" })) });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.details.fields[0].path).toBe("config.products.0.kind");
    expect((await readVersions())[0]!.version).toBe(latest);
  });

  it("allows a new ref, and removing a product", async () => {
    const latest = (await readVersions())[0]!.version;
    const res = await save({ baseVersion: latest, config: catalog(pack({ ref: "credits-1000" })) });
    expect(res.status).toBe(201);
  });
});
