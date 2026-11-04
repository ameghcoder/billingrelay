# Billing rules

## Integration paths

**Dashboard catalog.** The merchant backend authenticates its user and calls checkout with a configured
product/variant. BillingRelay resolves its trusted price and benefits, persists the snapshot, and returns a
platform-hosted checkout URL that uses PayPal.

```json
{
  "externalCustomerId": "app-user-42",
  "productRef": "template",
  "variantRef": "extended-license",
  "returnUrl": "https://app.example.com/billing/return"
}
```

**Backend quote.** The authenticated merchant backend creates a short-lived immutable quote with trusted product
references, metadata, quantity, integer amount and currency, bound to project, customer and payload hash.
Checkout references the quote ID. Expired or altered inputs fail.

**Recurring prices need PayPal plans.** A recurring config maps to a configured PayPal plan. Arbitrary recurring
quote amounts are rejected. Product metadata is traceability, not proof of inventory or fulfillment.

## Subscriptions

One monthly fixed plan per product, quantity one, no trial or proration. A successful initial payment establishes
paid access. Verified renewal payment evidence advances the paid-through interval. PayPal's status and the app's
access decision are stored separately.

Benefits dedupe on the PayPal payment identity and benefit kind, so activation plus payment can't produce two
grants. Guard one intended active subscription per customer/product, and show pending sessions before starting
another.

**Cancellation and failure.** Request cancellation through PayPal, then reconcile the actual result. The app can
retain already-paid access through its stored paid-through date. A failed renewal doesn't create another paid
period. Pending, suspended or halted states stay visible. Complex upgrades, refunds and proration are later policies.

**Open decision (M09): grace period.** Sandbox renewals post after the scheduled billing time (see `paypal.md`).
If access ends exactly at the billing time, paying subscribers lose access until the payment posts.

## Credit ledger

Append-only grants, debits and compensations. In a short transaction, lock the account or use an equivalent atomic
operation, insert the unique effect, and update the balance. Only a newly inserted effect changes the balance.
Credits are integers.

Debit before the sample operation. If it fails, append one linked compensation. Retries of the same usage ID return
the prior result. Competing requests can't spend the same final credits.

## Refund boundary

Refund or reversal evidence restricts affected access or spending pending review, and is surfaced explicitly.
Partial refunds, consumed-credit debt and automated refund execution need a later policy. Application credits aren't
transferable customer money. A late refund notification can still permit use before the restriction arrives; document
that exposure and define a production policy before any live release.

## Situations decided in advance

| Situation | Required behavior |
|---|---|
| Success redirect before capture | Show pending; only trusted payment facts authorize benefits |
| Callback + repeated webhook | Separate observation dedupe from unique business-effect identity |
| PayPal request times out | Inspect the existing operation; don't create a second charge. If unprovable, mark unresolved for review |
| Target database offline | Source commits its outbox; queue retries and shows sync lag |
| Target commits, acknowledgement lost | Idempotent target apply returns its existing version |
| Older job arrives later | Ignore the obsolete projection version |
| Two requests spend final credits | Atomic account change; only eligible usage succeeds |
| Usage reply lost | Same usage key returns the committed outcome, not a second debit |
| Subscription cancelled / payment failed | Separate PayPal lifecycle from existing paid-through access |
| Two subscription checkout attempts | Guard the intended active subscription; surface pending/active state |
| Catalog edits during checkout | Honor the immutable snapshot and expire invalid quotes |
| Refund after usage | Restrict and surface for review; don't invent a clawback policy |
| Currencies | Separate configured prices and totals; no implicit FX |
| Manual target edits | Billing tables are managed projections; reconcile or flag divergence |
| Unsupported or stale AI action | Validate type, scope, capability, fresh state/version and approval |

These policies must be visible in tests and status screens.
