import { describe, expect, it } from "vitest";
import { accessUntil, findSubscriptionMismatch, judgeSubscriptionPayment, nextSubscriptionCheck, statusForStage } from "./subscriptions";

const expected = { checkoutId: "c-1", planId: "P-1", amount: 900, currency: "USD" };

describe("accessUntil", () => {
  it("is 24 hours after the paid time, since renewals post hours late", () => {
    expect(accessUntil(new Date("2026-12-09T10:00:00Z"))).toEqual(new Date("2026-12-10T10:00:00Z"));
  });
});

describe("statusForStage", () => {
  it.each([
    ["waiting_for_buyer", "pending"],
    ["active", "active"],
    ["suspended", "suspended"],
    ["cancelled", "cancelled"],
    ["expired", "expired"],
  ] as const)("%s is %s", (stage, status) => {
    expect(statusForStage(stage, "pending")).toBe(status);
  });

  it("a stage that means nothing new keeps what's stored", () => {
    expect(statusForStage("other", "active")).toBe("active");
  });
});

describe("findSubscriptionMismatch", () => {
  it("our checkout and our plan is ours", () => {
    expect(findSubscriptionMismatch(expected, { customId: "c-1", planId: "P-1" })).toBeNull();
  });

  it.each([
    [{ customId: "c-2", planId: "P-1" }, "reference_mismatch"],
    [{ customId: null, planId: "P-1" }, "reference_mismatch"],
    [{ customId: "c-1", planId: "P-2" }, "plan_mismatch"],
  ] as const)("%j is %s", (read, reason) => {
    expect(findSubscriptionMismatch(expected, read)).toBe(reason);
  });
});

describe("judgeSubscriptionPayment", () => {
  it.each([
    [{ state: "completed", amount: 900, currency: "USD" }, "counts"],
    [{ state: "refunded", amount: 900, currency: "USD" }, "counts"],
    [{ state: "other", amount: 900, currency: "USD" }, "not_completed"],
    [{ state: "completed", amount: 100, currency: "USD" }, "amount_mismatch"],
    [{ state: "completed", amount: null, currency: "USD" }, "amount_mismatch"],
    [{ state: "completed", amount: 900, currency: "EUR" }, "currency_mismatch"],
  ] as const)("%j is %s", (payment, outcome) => {
    expect(judgeSubscriptionPayment(expected, payment)).toBe(outcome);
  });
});

describe("nextSubscriptionCheck", () => {
  const billing = new Date("2026-12-09T10:00:00Z");

  it("looks 1, 6 and 25 hours after the renewal is due, then stops", () => {
    expect(nextSubscriptionCheck(billing, new Date("2026-11-20T00:00:00Z"))).toEqual(new Date("2026-12-09T11:00:00Z"));
    expect(nextSubscriptionCheck(billing, new Date("2026-12-09T11:00:00Z"))).toEqual(new Date("2026-12-09T16:00:00Z"));
    expect(nextSubscriptionCheck(billing, new Date("2026-12-09T16:30:00Z"))).toEqual(new Date("2026-12-10T11:00:00Z"));
    expect(nextSubscriptionCheck(billing, new Date("2026-12-10T11:00:00Z"))).toBeNull();
  });

  it("no billing time, no look", () => {
    expect(nextSubscriptionCheck(null, new Date())).toBeNull();
  });
});
