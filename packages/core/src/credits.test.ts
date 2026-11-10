import { describe, expect, it } from "vitest";
import { allocateDebit, consumeRequestSchema, type SpendableLot } from "./credits";

const lot = (id: string, bucket: "monthly" | "pack", remaining: number, extra: Partial<SpendableLot> = {}): SpendableLot => ({
  id,
  bucket,
  remaining,
  expiresAt: bucket === "monthly" ? new Date("2026-12-10T10:00:00Z") : null,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  ...extra,
});

describe("allocateDebit", () => {
  it("spends monthly credits before packs", () => {
    expect(allocateDebit([lot("p", "pack", 100), lot("m", "monthly", 30)], 50)).toEqual([
      { lotId: "m", amount: 30 },
      { lotId: "p", amount: 20 },
    ]);
  });

  it("the monthly lot ending soonest first, then the oldest pack", () => {
    const lots = [
      lot("m-late", "monthly", 10, { expiresAt: new Date("2027-01-10T00:00:00Z") }),
      lot("m-soon", "monthly", 10, { expiresAt: new Date("2026-12-01T00:00:00Z") }),
      lot("p-new", "pack", 10, { createdAt: new Date("2026-11-05T00:00:00Z") }),
      lot("p-old", "pack", 10, { createdAt: new Date("2026-10-05T00:00:00Z") }),
    ];
    expect(allocateDebit(lots, 35)?.map((part) => part.lotId)).toEqual(["m-soon", "m-late", "p-old", "p-new"]);
  });

  it("exactly the balance works; one more is refused", () => {
    const lots = [lot("m", "monthly", 5), lot("p", "pack", 5)];
    expect(allocateDebit(lots, 10)).toHaveLength(2);
    expect(allocateDebit(lots, 11)).toBeNull();
  });

  it("nothing to spend is refused", () => {
    expect(allocateDebit([], 1)).toBeNull();
    expect(allocateDebit([lot("p", "pack", 0)], 1)).toBeNull();
  });

  it("takes nothing from a lot it doesn't need", () => {
    expect(allocateDebit([lot("m", "monthly", 100), lot("p", "pack", 100)], 1)).toEqual([{ lotId: "m", amount: 1 }]);
  });
});

describe("consumeRequestSchema", () => {
  it.each([
    [{ externalCustomerId: "u1", amount: 0, usageId: "job-1" }],
    [{ externalCustomerId: "u1", amount: 1.5, usageId: "job-1" }],
    [{ externalCustomerId: "u1", amount: 1, usageId: "has space" }],
    [{ externalCustomerId: "u1", amount: 1, usageId: "" }],
    [{ externalCustomerId: "u1", amount: 1, usageId: "job-1", extra: true }],
  ])("refuses %j", (body) => {
    expect(consumeRequestSchema.safeParse(body).success).toBe(false);
  });

  it("accepts a whole positive amount and a printable usage ID", () => {
    expect(consumeRequestSchema.safeParse({ externalCustomerId: "u1", amount: 5, usageId: "job-1" }).success).toBe(true);
  });
});
