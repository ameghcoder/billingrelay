// Runs against a live stack (see README), with the official MCP client. The E2E_WRITE_DB block creates keys and saves catalog versions,
// so only on a throwaway database.
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const DRAFTS = "/admin/config/drafts";
const RATE_LIMIT_WINDOW_MS = 11_000;

describe("mcp without a key", () => {
  it("refuses", async () => {
    const res = await fetch(`${BASE_URL}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});

describe.runIf(process.env.E2E_WRITE_DB === "1")("mcp", { timeout: 60_000 }, () => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let cookie: string;
  let mcpKey: string;
  let backendKey: string;
  let client: Client;
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(`${BASE_URL}${path}`, { redirect: "manual", ...init, headers: { Cookie: cookie, Origin: BASE_URL, "Content-Type": "application/json", ...init.headers } });
  const createKey = async (kind: string) => (await (await admin("/admin/developers/api-keys", { method: "POST", body: JSON.stringify({ name: `e2e ${kind}`, kind }) })).json()).key as string;
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })).structuredContent as Record<string, unknown>;

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
    mcpKey = await createKey("mcp");
    backendKey = await createKey("backend");
    client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpKey}` } } }));
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await db.end();
  });

  it("an MCP key says what it is, and each endpoint refuses the other kind", async () => {
    expect(mcpKey).toMatch(/^br_mcp_sandbox_/);
    const onV1 = await fetch(`${BASE_URL}/v1/customers/anyone/billing`, { headers: { Authorization: `Bearer ${mcpKey}` } });
    expect(onV1.status).toBe(403);
    expect((await onV1.json()).error.code).toBe("wrong_key_kind");
    const onMcp = await fetch(`${BASE_URL}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${backendKey}`, "Content-Type": "application/json" }, body: "{}" });
    expect(onMcp.status).toBe(403);
  });

  it("offers exactly the drafting and reading tools, and none that approves or goes live", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["check_catalog", "inspect_customer", "list_versions", "read_live_catalog", "save_draft"]);
    expect(names.some((name) => /approve|activ|live|publish/i.test(name) && name !== "read_live_catalog")).toBe(false);
  });

  it("checks a catalog and says what's wrong, saving nothing", async () => {
    const before = (await call("list_versions")).versions as unknown[];
    const result = await call("check_catalog", { config: { products: [{ ref: "Bad Ref", name: "x", kind: "rental", variants: [] }] } });
    expect(result.valid).toBe(false);
    expect((result.issues as unknown[]).length).toBeGreaterThan(0);
    expect(((await call("list_versions")).versions as unknown[]).length).toBe(before.length);
  });

  it("saves a draft that isn't approved or live, and making it live still needs a person", async () => {
    const config = {
      products: [{ ref: "mcp-pack", name: "MCP pack", kind: "credit_pack", variants: [{ ref: "d", name: "500", attributes: {}, price: { amount: 700, currency: "USD" }, benefits: [{ kind: "credits", amount: 500 }] }] }],
    };
    const saved = await call("save_draft", { config });
    expect(saved).toMatchObject({ saved: true, approved: false, live: false });
    const versions = (await (await admin(DRAFTS)).json()).versions as { id: string; version: number; approved: boolean; isLive: boolean }[];
    const created = versions.find((version) => version.version === saved.version)!;
    expect(created).toMatchObject({ approved: false, isLive: false });
    const refused = await admin(`${DRAFTS}/${created.id}/activate`, { method: "POST" });
    expect((await refused.json()).error.code).toBe("approval_required");
  });

  it("reads a customer's billing, and nothing for a stranger", async () => {
    expect(await call("inspect_customer", { externalCustomerId: `nobody-${Date.now()}` })).toEqual({ billing: null });
  });

  it("every call is audited under the key, without its arguments", async () => {
    const { rows } = await db.query("SELECT action, detail FROM audit_event WHERE actor_kind = 'mcp' ORDER BY created_at");
    const actions = new Set(rows.map((row) => row.action));
    for (const action of ["mcp.list_versions", "mcp.check_catalog", "mcp.save_draft", "mcp.inspect_customer"]) expect(actions.has(action)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("mcp-pack");
  });
});
