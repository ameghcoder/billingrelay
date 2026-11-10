import type { CatalogPorts } from "@billingrelay/ai";
import { catalogConfigSchema, toFieldIssues } from "@billingrelay/core/catalog";
import { getActiveCatalog, type ProjectScope } from "@billingrelay/db";
import { checkForActivation } from "./catalog";

/**
 * What the AI setup agent and MCP clients may do, scoped to one project by the server, never by the caller. Reads and checks only:
 * saving a version, approving it and making it live stay with a person.
 */
export function catalogPorts(scope: ProjectScope): CatalogPorts {
  return {
    async readLiveCatalog() {
      const live = await getActiveCatalog(scope);
      return live ? { version: live.version, config: live.config } : null;
    },
    async checkProposal(config) {
      const parsed = catalogConfigSchema.safeParse(config);
      if (!parsed.success) return { valid: false, issues: toFieldIssues(parsed.error) };
      // The same rules as going live, against what's live now: a live ref can't change kind.
      const issues = checkForActivation(parsed.data, (await getActiveCatalog(scope))?.config ?? null);
      return issues.length > 0 ? { valid: false, issues } : { valid: true, config: parsed.data };
    },
  };
}
