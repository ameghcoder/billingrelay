import { describe, expect, it } from "vitest";
import {
  addReturnOriginSchema,
  catalogCheckoutRequestSchema,
  findOrderMismatch,
  hasExpired,
  isSettled,
  judgeCaptures,
  nextActionFor,
  parseCheckoutRequest,
  quoteCheckoutRequestSchema,
  returnOriginOf,
  showMoneyStatus,
  type MoneyReason,
  type StoredMoneyStatus,
} from "./checkouts";

const CHECKOUT = "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const SELLER = "8JSFVJR57C5RA";
const expected = { checkoutId: CHECKOUT, amount: 2900, currency: "USD", sellerId: SELLER };
const RETURN_URL = "https://app.example.com/billing/return";

const order = (overrides: object = {}) => ({
  isCaptureIntent: true,
  purchaseUnitCount: 1,
  amount: 2900,
  currency: "USD",
  customId: CHECKOUT,
  sellerId: SELLER,
  ...overrides,
});

const capture = (overrides: object = {}) => ({
  id: "37L31305X26514342",
  state: "completed" as const,
  amount: 2900,
  currency: "USD",
  customId: CHECKOUT,
  sellerId: SELLER,
  ...overrides,
});

describe("findOrderMismatch", () => {
  it("accepts the order we asked for", () => {
    expect(findOrderMismatch(expected, order())).toBeNull();
  });

  it.each<[string, object, MoneyReason]>([
    ["another checkout's reference", { customId: "someone-else" }, "reference_mismatch"],
    ["no reference", { customId: null }, "reference_mismatch"],
    ["two purchase units", { purchaseUnitCount: 2 }, "reference_mismatch"],
    ["authorize instead of capture", { isCaptureIntent: false }, "intent_mismatch"],
    ["a lower amount", { amount: 100 }, "amount_mismatch"],
    ["a higher amount", { amount: 2901 }, "amount_mismatch"],
    ["an amount that couldn't be read", { amount: null }, "amount_mismatch"],
    ["another currency", { currency: "EUR" }, "currency_mismatch"],
    ["another seller", { sellerId: "OTHERSELLER" }, "seller_mismatch"],
    ["no seller", { sellerId: null }, "seller_mismatch"],
  ])("refuses %s", (_name, overrides, reason) => {
    expect(findOrderMismatch(expected, order(overrides))).toBe(reason);
  });

  it("refuses when no seller was recorded, even if PayPal's answer has none either", () => {
    expect(findOrderMismatch({ ...expected, sellerId: null }, order({ sellerId: null }))).toBe("seller_mismatch");
  });
});

describe("judgeCaptures", () => {
  it("only a completed capture that matches in full is captured", () => {
    expect(judgeCaptures(expected, [capture()])).toEqual({ moneyStatus: "captured", moneyReason: null, capture: capture() });
  });

  it("accepts a capture that doesn't repeat the reference, because it came from the checked order", () => {
    expect(judgeCaptures(expected, [capture({ customId: null })]).moneyStatus).toBe("captured");
  });

  it.each<[string, object, MoneyReason]>([
    ["another checkout's reference", { customId: "someone-else" }, "reference_mismatch"],
    ["a lower amount", { amount: 100 }, "amount_mismatch"],
    ["an amount that couldn't be read", { amount: null }, "amount_mismatch"],
    ["another currency", { currency: "EUR" }, "currency_mismatch"],
    ["another seller", { sellerId: "OTHERSELLER" }, "seller_mismatch"],
    ["no seller", { sellerId: null }, "seller_mismatch"],
    ["a refunded or unknown capture", { state: "other" }, "unexpected_capture"],
  ])("money may have moved, so %s is unresolved and keeps the evidence", (_name, overrides, reason) => {
    const seen = capture(overrides);
    expect(judgeCaptures(expected, [seen])).toEqual({ moneyStatus: "unresolved", moneyReason: reason, capture: seen });
  });

  it("no capture in the answer is unknown, so the next confirm can still find it", () => {
    const judged = judgeCaptures(expected, []);
    expect(judged).toEqual({ moneyStatus: "unresolved", moneyReason: "capture_outcome_unknown", capture: null });
    expect(isSettled({ moneyStatus: judged.moneyStatus, moneyReason: judged.moneyReason, captureRequestedAt: new Date(), isExpired: false })).toBe(false);
  });

  it("more than one capture is unresolved, and final", () => {
    expect(judgeCaptures(expected, [capture(), capture({ id: "second" })])).toMatchObject({ moneyStatus: "unresolved", moneyReason: "unexpected_capture" });
  });

  it("a pending capture stays approved", () => {
    expect(judgeCaptures(expected, [capture({ state: "pending" })])).toMatchObject({ moneyStatus: "approved", moneyReason: null });
  });

  it("a declined capture failed", () => {
    expect(judgeCaptures(expected, [capture({ state: "declined" })])).toMatchObject({ moneyStatus: "failed", moneyReason: "paypal_declined" });
  });
});

const state = (moneyStatus: StoredMoneyStatus, overrides: object = {}) => ({
  moneyStatus,
  moneyReason: null as MoneyReason | null,
  captureRequestedAt: null as Date | null,
  isExpired: false,
  ...overrides,
});

describe("judgeCaptures on a refunded capture", () => {
  const expected = { checkoutId: "c1", amount: 100, currency: "USD", sellerId: "S1" };
  const refunded = { id: "CAP", state: "refunded" as const, amount: 100, currency: "USD", customId: "c1", sellerId: "S1" };

  it("counts as captured, so the refund's own event can move it to review", () => {
    expect(judgeCaptures(expected, [refunded])).toMatchObject({ moneyStatus: "captured", moneyReason: null });
  });

  it("still has to match", () => {
    expect(judgeCaptures(expected, [{ ...refunded, amount: 1 }])).toMatchObject({ moneyStatus: "unresolved", moneyReason: "amount_mismatch" });
  });
});

describe("expiry", () => {
  it.each<StoredMoneyStatus>(["pending", "approved"])("%s past its time, with no capture sent, reads as expired", (status) => {
    const past = state(status, { isExpired: true });
    expect(hasExpired(past)).toBe(true);
    expect(showMoneyStatus(past)).toBe("expired");
    expect(isSettled(past)).toBe(true);
  });

  it("once a capture was sent, it never reads as expired: money may have moved", () => {
    const sent = state("approved", { isExpired: true, captureRequestedAt: new Date() });
    expect(hasExpired(sent)).toBe(false);
    expect(showMoneyStatus(sent)).toBe("approved");
    expect(isSettled(sent)).toBe(false);
  });

  it.each<StoredMoneyStatus>(["captured", "failed", "unresolved"])("%s stays %s past its time", (status) => {
    expect(showMoneyStatus(state(status, { isExpired: true }))).toBe(status);
  });
});

describe("isSettled", () => {
  it.each<[string, ReturnType<typeof state>, boolean]>([
    ["pending", state("pending"), false],
    ["approved", state("approved"), false],
    ["captured", state("captured"), true],
    ["failed", state("failed"), true],
    ["refund review", state("refund_review"), true],
    ["an unknown outcome", state("unresolved", { moneyReason: "capture_outcome_unknown" }), false],
    ["a mismatch", state("unresolved", { moneyReason: "amount_mismatch" }), true],
  ])("%s: %s", (_name, value, settled) => {
    expect(isSettled(value)).toBe(settled);
  });
});

describe("nextActionFor", () => {
  it.each([
    ["pending", "redirect"],
    ["approved", "wait"],
    ["captured", "none"],
    ["failed", "none"],
    ["expired", "none"],
    ["unresolved", "contact_support"],
    ["refund_review", "contact_support"],
  ] as const)("%s → %s", (money, action) => {
    expect(nextActionFor(money)).toBe(action);
  });
});

describe("parseCheckoutRequest", () => {
  const fromQuote = { externalCustomerId: "app-user-42", quoteId: CHECKOUT, returnUrl: RETURN_URL };
  const fromCatalog = { externalCustomerId: "app-user-42", productRef: "template", variantRef: "extended-license", returnUrl: RETURN_URL };

  it("reads both forms and applies the catalog form's defaults", () => {
    expect(parseCheckoutRequest(fromQuote).data).toEqual(fromQuote);
    expect(parseCheckoutRequest(fromCatalog).data).toEqual({ ...fromCatalog, quantity: 1, metadata: {} });
  });

  it.each(["unitAmount", "amount", "currency", "benefits", "expiresInSeconds", "status", "money"])("refuses %s on either form", (field) => {
    expect(parseCheckoutRequest({ ...fromCatalog, [field]: 1 }).error?.issues[0]?.code).toBe("unrecognized_keys");
    expect(parseCheckoutRequest({ ...fromQuote, [field]: 1 }).error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("refuses a quote that also names a product", () => {
    expect(parseCheckoutRequest({ ...fromQuote, productRef: "template" }).success).toBe(false);
  });

  it("requires returnUrl and the customer", () => {
    const { returnUrl: _returnUrl, ...noReturn } = fromQuote;
    const { externalCustomerId: _customer, ...noCustomer } = fromCatalog;
    expect(quoteCheckoutRequestSchema.safeParse(noReturn).success).toBe(false);
    expect(catalogCheckoutRequestSchema.safeParse(noCustomer).success).toBe(false);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "http://app.example.com/return",
    "ftp://app.example.com",
    "https://user:pass@app.example.com/return",
    "//app.example.com",
    "/billing/return",
    "not a url",
    `https://app.example.com/${"a".repeat(2048)}`,
  ])("refuses the return address %s", (returnUrl) => {
    expect(parseCheckoutRequest({ ...fromQuote, returnUrl }).success).toBe(false);
  });

  it("allows http only on this machine", () => {
    expect(parseCheckoutRequest({ ...fromQuote, returnUrl: "http://localhost:4000/back" }).success).toBe(true);
    expect(parseCheckoutRequest({ ...fromQuote, returnUrl: "http://127.0.0.1:4000/back" }).success).toBe(true);
    expect(parseCheckoutRequest({ ...fromQuote, returnUrl: "http://localhost.evil.test/back" }).success).toBe(false);
  });
});

describe("return origins", () => {
  it.each([
    ["https://app.example.com/billing?x=1", "https://app.example.com"],
    ["https://APP.example.com/", "https://app.example.com"],
    ["https://app.example.com:8443/x", "https://app.example.com:8443"],
  ])("%s has the origin %s", (url, origin) => {
    expect(returnOriginOf(url)).toBe(origin);
  });

  it("a lookalike host has a different origin", () => {
    expect(returnOriginOf("https://app.example.com.evil.test/x")).toBe("https://app.example.com.evil.test");
    expect(returnOriginOf("https://evil.test/https://app.example.com")).toBe("https://evil.test");
  });

  it.each(["https://app.example.com", "https://app.example.com/", "http://localhost:4000"])("the operator can add %s", (origin) => {
    expect(addReturnOriginSchema.safeParse({ origin }).data?.origin).toBe(origin.replace(/\/$/, ""));
  });

  it.each(["https://app.example.com/billing", "http://app.example.com", "app.example.com", "*", "https://user:pw@app.example.com", ""])(
    "the operator can't add %j",
    (origin) => {
      expect(addReturnOriginSchema.safeParse({ origin }).success).toBe(false);
    },
  );

  it("refuses unknown fields", () => {
    expect(addReturnOriginSchema.safeParse({ origin: "https://app.example.com", id: "x" }).success).toBe(false);
  });
});
