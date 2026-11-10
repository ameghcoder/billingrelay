// Runs against a live stack (see README), through HTTP. The E2E_WRITE_DB block saves catalog versions, so only on a throwaway database.
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const DRAFTS = "/admin/config/drafts";
const RATE_LIMIT_WINDOW_MS = 11_000;

describe("flow without a session", () => {
  it("the page redirects and edits are refused", async () => {
    expect((await fetch(`${BASE_URL}/admin/flow`, { redirect: "manual" })).status).toBe(307);
    expect((await fetch(`${BASE_URL}/admin/flow/01900000-0000-7000-8000-000000000000/edit`, { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe.runIf(process.env.E2E_WRITE_DB === "1")("flow", { timeout: 60_000 }, () => {
  let cookie: string;
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(`${BASE_URL}${path}`, { redirect: "manual", ...init, headers: { Cookie: cookie, Origin: BASE_URL, "Content-Type": "application/json", ...init.headers } });
  const versions = async () => (await (await admin(DRAFTS)).json()).versions as { id: string; version: number; approved: boolean; isLive: boolean }[];
  const edit = (versionId: string, body: unknown) => admin(`/admin/flow/${versionId}/edit`, { method: "POST", body: JSON.stringify(body) });

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
    const latest = (await versions())[0]?.version ?? 0;
    const saved = await admin(DRAFTS, {
      method: "POST",
      body: JSON.stringify({
        baseVersion: latest,
        config: {
          products: [
            { ref: "flow-pro", name: "Flow Pro", kind: "subscription", variants: [{ ref: "monthly", name: "Monthly", price: { amount: 1900, currency: "USD" }, benefits: [{ kind: "access", key: "flow-pro" }, { kind: "credits", amount: 2000 }] }] },
          ],
        },
      }),
    });
    expect(saved.status).toBe(201);
  }, 30_000);

  it("the page draws the latest version's steps", async () => {
    const latest = (await versions())[0]!;
    const page = await admin(`/admin/flow?version=${latest.version}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    for (const text of ["Checkout: Flow Pro", "PayPal monthly plan", "Verified payment", "2,000 each paid month"]) expect(html).toContain(text);
  });

  it("an edit saves a new version in the same history, not approved, and the old approval doesn't carry over", async () => {
    const before = (await versions())[0]!;
    expect((await admin(`${DRAFTS}/${before.id}/approve`, { method: "POST" })).status).toBe(200);
    const res = await edit(before.id, { type: "price", productRef: "flow-pro", variantRef: "monthly", amount: 2500 });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ version: before.version + 1, approved: false });

    const after = await versions();
    expect(after[0]).toMatchObject({ id: created.id, approved: false });
    expect(after.find((version) => version.id === before.id)).toMatchObject({ approved: true });
    const detail = await (await admin(`${DRAFTS}/${created.id}`)).json();
    expect(detail.config.products[0].variants[0].price.amount).toBe(2500);
    const refused = await admin(`${DRAFTS}/${created.id}/activate`, { method: "POST" });
    expect((await refused.json()).error.code).toBe("approval_required");
  });

  it("only the latest version can be edited, only the four settings, and only to valid values", async () => {
    const [latest, older] = await versions();
    expect((await edit(older!.id, { type: "price", productRef: "flow-pro", variantRef: "monthly", amount: 100 })).status).toBe(409);
    expect((await edit(latest!.id, { type: "kind", productRef: "flow-pro", kind: "one_time" })).status).toBe(400);
    expect((await edit(latest!.id, { type: "price", productRef: "flow-pro", variantRef: "monthly", amount: 0 })).status).toBe(400);
    expect((await edit(latest!.id, { type: "price", productRef: "flow-pro", variantRef: "monthly", amount: 2500 })).status).toBe(422);
    expect((await edit(latest!.id, { type: "credits", productRef: "nope", variantRef: "monthly", amount: 5 })).status).toBe(404);
    expect((await edit(latest!.id, { type: "access_key", productRef: "flow-pro", variantRef: "monthly", key: "flow-pro-plus" })).status).toBe(201);
  });
});
