// Approval invariants against real Postgres. Writes rows, so only on a throwaway database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activateCatalogVersion, approveCatalogVersion, closePools, saveCatalogVersion } from "../../packages/db/src/index";
import { getSourcePool } from "../../packages/db/src/client";

const db = () => getSourcePool();
const one = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) => (await db().query(text, values)).rows[0] as T;

describe.runIf(process.env.E2E_WRITE_DB === "1")("approval invariants", () => {
  let scope: { projectId: string; environment: "sandbox" };
  let userId: string;
  const config = (name: string) => ({
    products: [{ ref: "inv-approval", name, kind: "one_time", maxQuantity: 1, fields: [], variants: [{ ref: "d", name: "D", attributes: {}, price: { amount: 100, currency: "USD" }, benefits: [] }] }],
  });
  const saveNext = async (name: string) => {
    const latest = Number((await one<{ v: number | null }>("SELECT max(version) AS v FROM catalog_version WHERE project_id = $1 AND environment = 'sandbox'", [scope.projectId])).v ?? 0);
    const saved = await saveCatalogVersion({ ...scope, baseVersion: latest, config: config(name) as never, createdBy: userId });
    if (saved.status !== "saved") throw new Error("not saved");
    return saved.id;
  };
  const activate = (versionId: string) => activateCatalogVersion({ ...scope, versionId, activatedBy: userId, check: () => [] });

  beforeAll(async () => {
    scope = { projectId: (await one<{ id: string }>("SELECT id FROM project LIMIT 1")).id, environment: "sandbox" };
    userId = (await one<{ id: string }>('SELECT id FROM "user" LIMIT 1')).id;
  });

  afterAll(async () => {
    await closePools();
  });

  it("a stored config changed after approval can't go live on that approval", async () => {
    const id = await saveNext("Before");
    expect((await approveCatalogVersion({ ...scope, versionId: id, approvedBy: userId })).status).toBe("approved");
    // Labelled: a row changed by hand, which no code path does.
    await db().query("UPDATE catalog_version SET config = $1 WHERE id = $2", [JSON.stringify(config("Changed by hand")), id]);
    expect((await activate(id)).status).toBe("approval_required");
  });

  it("the same config with its keys in another order is still the approved one", async () => {
    const id = await saveNext("Order");
    await approveCatalogVersion({ ...scope, versionId: id, approvedBy: userId });
    const stored = (await one<{ config: Record<string, unknown> }>("SELECT config FROM catalog_version WHERE id = $1", [id])).config;
    const reordered = Object.fromEntries(Object.entries(stored).reverse());
    await db().query("UPDATE catalog_version SET config = $1 WHERE id = $2", [JSON.stringify(reordered), id]);
    expect((await activate(id)).status).toBe("activated");
  });

  it("approving and going live are both in the audit trail", async () => {
    const id = await saveNext("Audited");
    await approveCatalogVersion({ ...scope, versionId: id, approvedBy: userId });
    await activate(id);
    const { n } = await one<{ n: string }>("SELECT count(*) AS n FROM audit_event WHERE target = $1 AND action IN ('catalog.approve', 'catalog.activate')", [id]);
    expect(Number(n)).toBe(2);
  });
});
