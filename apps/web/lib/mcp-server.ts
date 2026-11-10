import { externalCustomerIdSchema } from "@billingrelay/core/quotes";
import { getCustomerBilling, listCatalogVersions, recordAudit, saveCatalogVersion, type ActiveApiKey } from "@billingrelay/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { catalogPorts } from "./billing-tools";

const APPROVAL_NOTE = "Saved as a new version, not approved and not live. A person approves it and makes it live in the BillingRelay dashboard.";

/**
 * The tools an MCP client gets, scoped to its key's project by the server. The same reads and checks as AI setup, plus saving a
 * version and reading a customer's billing. There is deliberately no tool to approve a version or make it live.
 */
export function createMcpServer(apiKey: ActiveApiKey): McpServer {
  const scope = { projectId: apiKey.projectId, environment: apiKey.environment };
  const ports = catalogPorts(scope);
  const server = new McpServer({ name: "billingrelay", version: "0.1.0" });

  const reply = async (tool: string, result: unknown, detail: Record<string, unknown> = {}) => {
    // Which tool and what it touched; never its arguments, which can carry customer IDs or whole catalogs.
    await recordAudit({ projectId: scope.projectId, actorKind: "mcp", actorId: apiKey.id, action: `mcp.${tool}`, detail });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  };

  server.registerTool(
    "read_live_catalog",
    { description: "The catalog that's live now, with its version. Null when nothing is live.", inputSchema: {} },
    async () => reply("read_live_catalog", { live: await ports.readLiveCatalog() }),
  );

  server.registerTool(
    "check_catalog",
    {
      description: "Checks a whole catalog ({ products: [...] }) against every rule, including what's live. Saves nothing.",
      inputSchema: { config: z.object({ products: z.array(z.record(z.string(), z.unknown())) }) },
    },
    async ({ config }) => {
      const checked = await ports.checkProposal(config);
      return reply("check_catalog", checked.valid ? { valid: true } : { valid: false, issues: checked.issues });
    },
  );

  server.registerTool(
    "save_draft",
    {
      description: "Saves a whole catalog as a new version after checking it. It isn't approved or live: only a person can do that, in the dashboard.",
      inputSchema: { config: z.object({ products: z.array(z.record(z.string(), z.unknown())) }) },
    },
    async ({ config }) => {
      const checked = await ports.checkProposal(config);
      if (!checked.valid) return reply("save_draft", { saved: false, issues: checked.issues }, { saved: false });
      const latest = (await listCatalogVersions(scope))[0]?.version ?? 0;
      // Saved in the name of the operator who created this key, so the version's history says who's answerable for it.
      const saved = await saveCatalogVersion({ ...scope, baseVersion: latest, config: checked.config as never, createdBy: apiKey.createdBy });
      if (saved.status === "conflict") return reply("save_draft", { saved: false, reason: "someone saved a newer version first; try again" }, { saved: false });
      return reply("save_draft", { saved: true, version: saved.version, approved: false, live: false, note: APPROVAL_NOTE }, { saved: true, version: saved.version });
    },
  );

  server.registerTool(
    "list_versions",
    { description: "Saved catalog versions, newest first, with which is live and which are approved.", inputSchema: {} },
    async () => {
      const versions = await listCatalogVersions(scope);
      return reply("list_versions", {
        versions: versions.map((version) => ({ version: version.version, live: version.isLive, approved: version.approved, products: version.productCount, createdAt: version.createdAt.toISOString() })),
      });
    },
  );

  server.registerTool(
    "inspect_customer",
    {
      description: "One customer's billing: access, subscriptions, paid purchases and credits. Read-only.",
      inputSchema: { externalCustomerId: externalCustomerIdSchema },
    },
    async ({ externalCustomerId }) => reply("inspect_customer", { billing: await getCustomerBilling(scope, externalCustomerId) }),
  );

  return server;
}
