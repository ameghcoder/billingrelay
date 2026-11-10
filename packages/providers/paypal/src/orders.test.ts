import { describe, expect, it } from "vitest";
import { captureRefusal, fromPaypalValue, isOrderGone, PaypalError, readEvent, toOrder, toPaypalValue } from "./index";

describe("toPaypalValue", () => {
  it.each([
    [1, "0.01"],
    [10, "0.10"],
    [100, "1.00"],
    [2900, "29.00"],
    [2905, "29.05"],
    [99_999_999, "999999.99"],
  ])("%i is %s", (minor, text) => {
    expect(toPaypalValue(minor)).toBe(text);
  });
});

describe("fromPaypalValue", () => {
  it.each([
    ["1.0", 100],
    ["1.00", 100],
    ["1", 100],
    ["0.01", 1],
    ["0.10", 10],
    ["29.05", 2905],
    ["19.99", 1999],
    ["999999.99", 99_999_999],
  ])("%s is %i, with no rounding", (text, minor) => {
    expect(fromPaypalValue(text)).toBe(minor);
  });

  it.each(["", " 1.00", "1.000", "1.", ".50", "-1.00", "1,00", "1e2", "abc", "0x10", "1234567890.00"])("%j isn't a value", (text) => {
    expect(fromPaypalValue(text)).toBeNull();
  });

  it("round-trips amounts that floats get wrong", () => {
    for (const minor of [1, 7, 29, 57, 58, 110, 1001, 1999, 4035, 8990, 99_999_999]) {
      expect(fromPaypalValue(toPaypalValue(minor))).toBe(minor);
    }
  });
});

// Shapes copied from PayPal's real sandbox answers, with buyer details left out.
const NEW_ORDER = {
  id: "7UK90988KC644472B",
  status: "PAYER_ACTION_REQUIRED",
  intent: "CAPTURE",
  purchase_units: [
    {
      reference_id: "default",
      custom_id: "checkout-1",
      amount: { currency_code: "USD", value: "2.00", breakdown: { item_total: { currency_code: "USD", value: "2.00" } } },
      payee: { email_address: "seller@example.com", merchant_id: "8JSFVJR57C5RA" },
    },
  ],
  links: [
    { href: "https://api.sandbox.paypal.com/v2/checkout/orders/7UK90988KC644472B", rel: "self", method: "GET" },
    { href: "https://www.sandbox.paypal.com/checkoutnow?token=7UK90988KC644472B", rel: "payer-action", method: "GET" },
  ],
};

describe("toOrder", () => {
  it("reads a new order: seller, reference and approval link", () => {
    expect(toOrder(NEW_ORDER)).toEqual({
      id: "7UK90988KC644472B",
      stage: "waiting_for_buyer",
      isCaptureIntent: true,
      purchaseUnitCount: 1,
      amount: 200,
      currency: "USD",
      customId: "checkout-1",
      sellerId: "8JSFVJR57C5RA",
      approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=7UK90988KC644472B",
      captures: [],
    });
  });

  it("reads a capture inside an order, taking the seller from the purchase unit", () => {
    const [unit] = NEW_ORDER.purchase_units;
    const captured = toOrder({
      ...NEW_ORDER,
      status: "COMPLETED",
      purchase_units: [
        {
          ...unit,
          payments: { captures: [{ id: "37L31305X26514342", status: "COMPLETED", amount: { currency_code: "USD", value: "2.00" }, custom_id: "checkout-1" }] },
        },
      ],
    });
    expect(captured.captures).toEqual([
      { id: "37L31305X26514342", state: "completed", amount: 200, currency: "USD", customId: "checkout-1", sellerId: "8JSFVJR57C5RA" },
    ]);
    expect(captured.stage).toBe("completed");
  });

  it.each([
    ["CREATED", "waiting_for_buyer"],
    ["SAVED", "waiting_for_buyer"],
    ["APPROVED", "approved"],
    ["VOIDED", "voided"],
    ["SOMETHING_NEW", "other"],
    ["constructor", "other"],
  ])("order status %s is %s", (status, stage) => {
    expect(toOrder({ ...NEW_ORDER, status }).stage).toBe(stage);
  });

  it("an order that isn't for immediate capture says so", () => {
    expect(toOrder({ ...NEW_ORDER, intent: "AUTHORIZE" }).isCaptureIntent).toBe(false);
    const { intent: _intent, ...noIntent } = NEW_ORDER;
    expect(toOrder(noIntent).isCaptureIntent).toBe(false);
  });

  it.each([
    ["COMPLETED", "completed"],
    ["PENDING", "pending"],
    ["DECLINED", "declined"],
    ["FAILED", "declined"],
    ["REFUNDED", "refunded"],
    ["PARTIALLY_REFUNDED", "refunded"],
    ["SOMETHING_NEW", "other"],
  ])("capture status %s is %s", (status, state) => {
    const [unit] = NEW_ORDER.purchase_units;
    const payments = { captures: [{ id: "c", status, amount: { currency_code: "USD", value: "2.00" } }] };
    expect(toOrder({ ...NEW_ORDER, purchase_units: [{ ...unit, payments }] }).captures[0]?.state).toBe(state);
  });

  it("gives null for an amount it can't read, instead of guessing", () => {
    const [unit] = NEW_ORDER.purchase_units;
    const order = toOrder({ ...NEW_ORDER, purchase_units: [{ ...unit, amount: { currency_code: "USD", value: "2,00" } }] });
    expect(order.amount).toBeNull();
  });

  it.each([null, "not an order", {}, { id: "x" }, { id: "x", status: "APPROVED", purchase_units: "no" }])("treats %j as an unusable answer", (body) => {
    expect(() => toOrder(body)).toThrow(PaypalError);
  });
});

describe("what a refused capture means", () => {
  const refused = (issue?: string) => new PaypalError("rejected", "UNPROCESSABLE_ENTITY", undefined, issue);

  it.each(["INSTRUMENT_DECLINED", "TRANSACTION_REFUSED", "PAYER_CANNOT_PAY"])("%s is a decline", (issue) => {
    expect(captureRefusal(refused(issue))).toBe("declined");
  });

  it("ORDER_ALREADY_CAPTURED means look at the order, not that it failed", () => {
    expect(captureRefusal(refused("ORDER_ALREADY_CAPTURED"))).toBe("already_captured");
  });

  // These don't prove no money moved, so they mustn't let a merchant start a second charge.
  it.each(["ORDER_COMPLETION_IN_PROGRESS", "ORDER_NOT_APPROVED", "SOMETHING_NEW", undefined])("%s proves nothing", (issue) => {
    expect(captureRefusal(refused(issue))).toBe("other");
  });

  it("only PayPal's not-found means the order is gone", () => {
    expect(isOrderGone(new PaypalError("rejected", "RESOURCE_NOT_FOUND"))).toBe(true);
    expect(isOrderGone(new PaypalError("rejected", "NOT_AUTHORIZED"))).toBe(false);
    expect(isOrderGone(new PaypalError("unavailable"))).toBe(false);
  });
});

// Trimmed from what PayPal's sandbox really sent, 6 Nov 2026.
const REAL_EVENTS = {
  approved: {
    resource_type: "checkout-order",
    resource: {
      id: "8A522041TA517552K",
      status: "APPROVED",
      purchase_units: [{ custom_id: "01a1af4b-5593-7712-8267-840fa1ad3760" }],
      links: [{ rel: "capture", href: "https://api.sandbox.paypal.com/v2/checkout/orders/8A522041TA517552K/capture" }],
    },
  },
  captured: {
    resource_type: "capture",
    resource: {
      id: "9Y292266C6453680L",
      status: "COMPLETED",
      custom_id: "01a1af4b-5593-7712-8267-840fa1ad3760",
      supplementary_data: { related_ids: { order_id: "8A522041TA517552K" } },
      links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/checkout/orders/8A522041TA517552K" }],
    },
  },
  refunded: {
    resource_type: "refund",
    resource: {
      id: "9LD10144R6977221S",
      status: "COMPLETED",
      custom_id: "01a1af43-ce2b-7092-8ad5-0feb71f153f2",
      links: [
        { rel: "self", href: "https://api.sandbox.paypal.com/v2/payments/refunds/9LD10144R6977221S" },
        { rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/8K996419ET0148626" },
      ],
    },
  },
};

describe("readEvent", () => {
  it("an approved order names its checkout and order", () => {
    expect(readEvent("CHECKOUT.ORDER.APPROVED", REAL_EVENTS.approved)).toEqual({
      signal: "order_approved",
      checkoutId: "01a1af4b-5593-7712-8267-840fa1ad3760",
      orderId: "8A522041TA517552K",
      captureId: null,
      subscriptionId: null,
    });
  });

  it.each(["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED"])("%s names its checkout and order", (type) => {
    expect(readEvent(type, REAL_EVENTS.captured)).toEqual({
      signal: "capture_changed",
      checkoutId: "01a1af4b-5593-7712-8267-840fa1ad3760",
      orderId: "8A522041TA517552K",
      captureId: null,
      subscriptionId: null,
    });
  });

  it("a refund names its capture through its up link", () => {
    expect(readEvent("PAYMENT.CAPTURE.REFUNDED", REAL_EVENTS.refunded)).toEqual({
      signal: "capture_refunded",
      checkoutId: "01a1af43-ce2b-7092-8ad5-0feb71f153f2",
      orderId: null,
      captureId: "8K996419ET0148626",
      subscriptionId: null,
    });
  });

  it("a refund whose up link isn't a capture names no capture", () => {
    const resource = { custom_id: "x", links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/refunds/1" }] };
    expect(readEvent("PAYMENT.CAPTURE.REFUNDED", { resource }).captureId).toBeNull();
  });

  it("a type we don't handle is not acted on", () => {
    expect(readEvent("SOMETHING.NEW", REAL_EVENTS.captured)).toEqual({
      signal: "other",
      checkoutId: null,
      orderId: null,
      captureId: null,
      subscriptionId: null,
    });
  });

  it.each([[null], ["text"], [{}], [{ resource: "text" }], [{ resource: { custom_id: 5 } }]])("%j names nothing, and doesn't throw", (payload) => {
    const facts = readEvent("PAYMENT.CAPTURE.COMPLETED", payload);
    expect(facts).toMatchObject({ checkoutId: null, orderId: null });
  });
});
