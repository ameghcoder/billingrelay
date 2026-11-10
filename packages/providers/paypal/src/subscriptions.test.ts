import { describe, expect, it } from "vitest";
import { PaypalError, readEvent, toSubscription, toSubscriptionPayments } from "./index";

// Trimmed from real sandbox payloads (M00 and M09): the fields we read, as PayPal sent them. No buyer details.
const REAL = {
  activated: {
    event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
    resource: {
      id: "I-937ASKVASBHS",
      plan_id: "P-4J094806PM243042RNLQ7V6Q",
      status: "ACTIVE",
      billing_info: {
        last_payment: { amount: { currency_code: "USD", value: "1.0" }, time: "2026-10-28T14:23:34Z" },
        next_billing_time: "2026-10-29T10:00:00Z",
        failed_payments_count: 0,
      },
    },
  },
  sale: {
    event_type: "PAYMENT.SALE.COMPLETED",
    resource: {
      id: "0LV9673837477184L",
      state: "completed",
      amount: { total: "1.00", currency: "USD", details: { subtotal: "1.00" } },
      billing_agreement_id: "I-937ASKVASBHS",
    },
  },
  transactions: {
    transactions: [
      { id: "9UY9687470652270U", status: "COMPLETED", time: "2026-11-09T12:10:17.000Z", amount_with_breakdown: { gross_amount: { currency_code: "USD", value: "1.00" } } },
      { id: "0LV9673837477184L", status: "COMPLETED", time: "2026-10-28T14:23:34.000Z", amount_with_breakdown: { gross_amount: { currency_code: "USD", value: "1.00" } } },
    ],
    links: [],
  },
};

describe("subscription events", () => {
  it("an activation names its subscription and, when set, our checkout", () => {
    expect(readEvent("BILLING.SUBSCRIPTION.ACTIVATED", REAL.activated)).toEqual({
      signal: "subscription_changed",
      checkoutId: null,
      orderId: null,
      captureId: null,
      subscriptionId: "I-937ASKVASBHS",
    });
    const ours = { resource: { ...REAL.activated.resource, custom_id: "01a1af4b-5593-7712-8267-840fa1ad3760" } };
    expect(readEvent("BILLING.SUBSCRIPTION.CANCELLED", ours).checkoutId).toBe("01a1af4b-5593-7712-8267-840fa1ad3760");
  });

  it("a sale names its subscription only through billing_agreement_id", () => {
    expect(readEvent("PAYMENT.SALE.COMPLETED", REAL.sale)).toMatchObject({
      signal: "subscription_changed",
      subscriptionId: "I-937ASKVASBHS",
      checkoutId: null,
      captureId: "0LV9673837477184L",
    });
  });

  it.each(["BILLING.SUBSCRIPTION.SUSPENDED", "BILLING.SUBSCRIPTION.PAYMENT.FAILED"])("%s is a subscription change", (type) => {
    expect(readEvent(type, REAL.activated).signal).toBe("subscription_changed");
  });

  it("a sale with no agreement names nothing", () => {
    expect(readEvent("PAYMENT.SALE.COMPLETED", { resource: { id: "X" } }).subscriptionId).toBeNull();
  });
});

describe("toSubscription", () => {
  it("reads PayPal's real subscription", () => {
    expect(toSubscription(REAL.activated.resource)).toEqual({
      id: "I-937ASKVASBHS",
      stage: "active",
      planId: "P-4J094806PM243042RNLQ7V6Q",
      customId: null,
      nextBillingTime: new Date("2026-10-29T10:00:00Z"),
      approvalUrl: null,
    });
  });

  it.each([
    ["APPROVAL_PENDING", "waiting_for_buyer"],
    ["APPROVED", "other"],
    ["SUSPENDED", "suspended"],
    ["CANCELLED", "cancelled"],
    ["EXPIRED", "expired"],
    ["SOMETHING_NEW", "other"],
  ])("%s is %s", (status, stage) => {
    expect(toSubscription({ id: "I-1", status }).stage).toBe(stage);
  });

  it("finds the approve link", () => {
    const body = { id: "I-1", status: "APPROVAL_PENDING", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1" }] };
    expect(toSubscription(body).approvalUrl).toBe("https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1");
  });

  it("an unreadable next billing time is null, never a guess", () => {
    expect(toSubscription({ id: "I-1", status: "ACTIVE", billing_info: { next_billing_time: "soon" } }).nextBillingTime).toBeNull();
  });

  it("junk is unavailable, never a stage", () => {
    expect(() => toSubscription({ status: "ACTIVE" })).toThrow(PaypalError);
  });
});

describe("toSubscriptionPayments", () => {
  it("reads PayPal's real transactions, IDs the same as the sale events'", () => {
    expect(toSubscriptionPayments(REAL.transactions)).toEqual([
      { id: "9UY9687470652270U", state: "completed", amount: 100, currency: "USD", paidAt: new Date("2026-11-09T12:10:17.000Z") },
      { id: "0LV9673837477184L", state: "completed", amount: 100, currency: "USD", paidAt: new Date("2026-10-28T14:23:34.000Z") },
    ]);
  });

  it("no transactions is an empty list", () => {
    expect(toSubscriptionPayments({ links: [] })).toEqual([]);
  });

  it.each([
    ["REFUNDED", "refunded"],
    ["PARTIALLY_REFUNDED", "refunded"],
    ["DECLINED", "other"],
    ["PENDING", "other"],
  ])("%s is %s", (status, state) => {
    const body = { transactions: [{ id: "X", status, time: "2026-11-09T12:10:17Z", amount_with_breakdown: { gross_amount: { currency_code: "USD", value: "1.00" } } }] };
    expect(toSubscriptionPayments(body)[0]?.state).toBe(state);
  });
});
