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

A quote's price comes from one of two places:

- **The live catalog.** The request names a product and variant. Sending a price is refused, and a draft is never used.
- **The merchant's own catalog.** Its backend names the price, for one-time items only. This is safe while the API key stays on that
  backend. If the merchant copies a price from its own browser into the request, BillingRelay can't detect it, so never do that.
  The ref can't match a live catalog product, so a catalog price can't be undercut. These quotes can grant one access benefit or
  nothing, never credits: credits come only from a reviewed catalog, so a leaked key can't create them.

| Area | Rule |
|---|---|
| Kinds | `one_time` and `credit_pack`. A subscription starts from a PayPal plan, not a quote |
| Quantity | 1 to 100, and no more than the product's `maxQuantity` |
| Total | `unitAmount × quantity`, up to 99,999,999 minor units |
| Customer | The merchant's own user ID: 1 to 128 characters, no spaces at either end, no control characters. An exact match, never an email lookup |
| Expiry | Default 30 minutes, allowed 1 to 60, measured by the database's clock |
| Benefits | Stored per unit, so 2 packs of 5,000 credits grant 10,000 |

A stored quote never changes. Later catalog edits don't affect it, including removing its product: it keeps its price until it expires.

**Checkout.** A checkout holds its own copy of the snapshot, and it never changes. The PayPal order is created when the buyer clicks Pay, not
before, so an abandoned checkout leaves nothing at PayPal.

| Area | Rule |
|---|---|
| Quote use | One quote gets one checkout, ever. If that checkout fails or expires, the merchant makes a new quote |
| Life | 1 hour from creation, by the database's clock, so a price lasts 2 hours at most. A buyer who approves after that isn't charged |
| Return address | Its origin must be allowed by the operator, as an exact match, so a checkout link can't send buyers to another site |
| Two checkouts | Different `Idempotency-Key`s on catalog checkouts are two purchases, and a buyer could pay both. That's the merchant's choice |

**One charge at most.** One checkout has one order, and one order has one capture. No code path replaces an order. A capture's request is
recorded before it's sent, so a crash can't look like "nothing happened", and once it's recorded the checkout never reads as expired.
A lost answer is `unresolved`, and the next confirm reads the order at PayPal to find out. `captured` needs a completed capture matching the amount,
currency, seller and reference. A capture that doesn't match stays `unresolved` for review, because money did move.

**Recurring prices need PayPal plans.** A recurring config maps to a configured PayPal plan. Arbitrary recurring
quote amounts are rejected. Product metadata is traceability, not proof of inventory or fulfillment.

## Catalog

What a project sells is one JSON document per version. Saving always makes a new version and never changes a stored
one, and saving doesn't change what's live: activating is a separate step. A version only goes live if it still passes
every rule at that moment. Checkout code reads only the live version, and each purchase keeps its own snapshot.

Custom fields describe variants and are set by the merchant, such as a license type. Buyers don't fill them in.

| Area | Rule |
|---|---|
| Refs | Lowercase letters, numbers, `-` and `_`, starting with a letter or number, up to 64 characters. Product refs are unique; variant refs are unique inside a product |
| Price | Positive whole number of minor units, up to 99,999,999. Never a decimal or a string |
| Currency | USD, EUR, GBP, CAD or AUD. Zero-decimal currencies are refused, because minor units would be wrong |
| Fields | Types: text, number, integer, boolean, enum. Limits: required, range, length. No patterns or code |
| Attributes | Each variant must match its product's fields, with no unknown keys or missing required values. No two variants in a product may have identical attributes |
| `one_time` | One or more variants; an access benefit or none; `maxQuantity` 1 to 100 |
| `credit_pack` | One or more variants; a credits benefit only; `maxQuantity` 1 to 100 |
| `subscription` | Exactly one variant, billed monthly, quantity one. Access is required, credits are optional |
| Credits | Whole positive number, up to 1,000,000,000. At most one benefit of each kind per variant |
| Unsupported | Trials, proration, tax, inventory and any other unknown field are refused, not ignored |
| History | A ref in the live version can't change kind. Use a new ref, because its past purchases mean something else |
| Size | At least 1 and up to 50 products; up to 20 variants and 10 fields per product; up to 20 options per field |

The rules live in one Zod schema, `packages/core/src/catalog.ts`. The JSON Schema shown to the operator is generated
from the same object that validates attributes.

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

**Grace period (decided for M09).** Access lasts until PayPal's next billing time after the last counted payment (`paid_through`), plus
24 hours. Sandbox renewals posted 2 to 6 hours after the billing time (13 cycles observed), so ending exactly at the billing time would cut off
subscribers who paid. Monthly credits end at the same moment.

**As built (M09).**

| Area | Rule |
|---|---|
| Start | Only from the live catalog, quantity 1. Pay creates the PayPal subscription with our checkout ID as `custom_id`, on the plan for that exact price |
| Plans | Made at PayPal the first time anyone buys at a price, then reused. A new price is a new plan, so a subscriber's price never changes |
| Facts | An event, the buyer's return and the worker's own looks all ask PayPal for the subscription and its transactions. The event's amounts are never used |
| One effect | One row per PayPal sale ID (the same ID the sale event and the transaction list use). Only a new row that counts moves `paid_through` |
| Counts | Completed, for exactly the plan's price and currency, on our subscription (reference and plan). Anything else goes to review and grants nothing |
| Access | One grant per subscription, with `active_until`. It ends by time: no job has to run for access to stop |
| Missed events | The worker looks 1, 6 and 25 hours after each renewal is due, and every 15 minutes for 3 hours while the buyer hasn't approved |
| Late approval | PayPal charges when the buyer approves, even after the checkout's hour. That's honoured: the plan's price is fixed and money moved |
| One wanted | One active, suspended or unexpired pending subscription per customer and product. Checked with the customer's row locked |
| Cancel | Asks PayPal to cancel, then reads the result. `paid_through` never moves backwards |

## Credit ledger

Append-only grants, debits and compensations. In a short transaction, lock the account or use an equivalent atomic
operation, insert the unique effect, and update the balance. Only a newly inserted effect changes the balance.
Credits are integers.

Debit before the sample operation. If it fails, append one linked compensation. Retries of the same usage ID return
the prior result. Competing requests can't spend the same final credits.

**Monthly and pack credits.** Credits from a subscription last for the paid month. Unused ones don't carry over: a paid
renewal ends them and adds the new month's credits. After cancelling, the customer keeps them until the paid month
ends. A failed renewal adds none. Credit packs are bought outright, stay separate and never expire, even if the
subscription ends. Monthly credits are spent first. Expiry is a new ledger entry, never a deletion, and spending checks
the end date itself so a delayed job can't allow expired credits to be used. The M09 grace period applies to credits as
well as access.

**As built (M11).**

| Area | Rule |
|---|---|
| Lots | Each payment grants one lot: a pack's capture, or a subscription's counted sale. Unique on the PayPal payment ID, so repeats grant nothing |
| Amount | Per unit times quantity for packs; the monthly amount for each paid month. `bigint` |
| Lock | Every change locks the customer's credit account row first, so spends, grants, refunds and expiry happen one after another |
| Spend | Monthly lots first (soonest ending first), then packs (oldest first). Only active lots with credits left and not past their end. Not enough: nothing is stored |
| Usage ID | One debit per usage ID in a project and environment. A different amount or customer on it is a conflict |
| Compensation | One per debit, back to the same lots. A monthly lot that ended meanwhile gets them back but can't spend them |
| Renewal | Ends the last month's leftover with an expiry entry, then grants the new month |
| Lapsed month | Can't be spent from its end time. The worker writes its expiry entry afterwards, so the ledger and the synced balance say so |
| Refund | The refunded pack's lot is restricted. Credits already spent stay spent; other lots stay spendable |
| Invariant | For every account, the sum of its entries equals what its lots hold |

## Processing

Once PayPal has told us something, the worker finishes the job, whether or not the buyer comes back.

| Area | Rule |
|---|---|
| An event | Only says which checkout to look at. The worker asks PayPal for the facts, through the same code as `/confirm`, so repeats and events out of order can't matter |
| The job | The stored row. pg-boss only wakes the worker, so a lost job loses nothing |
| Order of work | Money first, then benefits, in separate transactions, so a failure applying benefits can't hide that the money arrived |
| One effect | Unique on the PayPal payment ID and benefit kind. Only a newly inserted row changes anything |
| Retries | 5s, 30s, 2m, 10m, then hourly. An event stops after 8 attempts and shows `failed`. A payment with an unknown outcome is asked about for about 24 hours, then stays `unresolved` for a person |
| A killed worker | Its event's 2-minute lease runs out and another attempt takes it |
| Expiry | An approved order the worker hears about after the checkout's hour isn't captured |
| Not covered | An approved order whose event never arrived. Finding those is reconciliation (M14) |

Every billing change writes an outbox row in the same transaction, and the row only points at the record. Prices and benefits come only from the
snapshot, never from an event.

## Refund boundary

A verified refund event for the capture on record moves money from `captured` to `refund_review`, sets fulfillment to `restricted` and restricts the grant
from that payment, in one transaction. Full and partial refunds do the same, and a second refund changes nothing. A customer's grants from other purchases stay active.

Refund or reversal evidence restricts affected access or spending pending review, and is surfaced explicitly.
Partial refunds, consumed-credit debt and automated refund execution need a later policy. Application credits aren't
transferable customer money. A late refund notification can still permit use before the restriction arrives; document
that exposure and define a production policy before any live release.

## Situations decided in advance

| Situation | Required behavior |
|---|---|
| Success redirect before capture | Show confirming, then ask PayPal; only trusted payment facts authorize benefits |
| Buyer approves and never returns | The worker captures it from the stored event, or reopening the link does. Nothing is captured after the checkout's hour |
| Callback + repeated webhook | Separate observation dedupe from unique business-effect identity |
| PayPal request times out | Inspect the existing operation; don't create a second charge. If unprovable, mark unresolved for review |
| Target database offline | Source commits its outbox; queue retries and shows sync lag |
| Target commits, acknowledgement lost | Idempotent target apply returns its existing version |
| Older job arrives later | Ignore the obsolete projection version |
| Two requests spend final credits | Atomic account change; only eligible usage succeeds |
| Usage reply lost | Same usage key returns the committed outcome, not a second debit |
| Subscription cancelled / payment failed | Separate PayPal lifecycle from existing paid-through access |
| Two subscription checkout attempts | Guard the intended active subscription; surface pending/active state |
| Catalog edits during checkout | Honor the immutable snapshot. A quote for a changed or removed product keeps its price and runs out within 60 minutes |
| Refund before we recorded the capture | The refund's event confirms the payment first, then moves it to review. No benefits are applied |
| Refund after usage | Restrict and surface for review; don't invent a clawback policy |
| Currencies | Separate configured prices and totals; no implicit FX |
| Manual target edits | Billing tables are managed projections; reconcile or flag divergence |
| Unsupported or stale AI action | Validate type, scope, capability, fresh state/version and approval |

These policies must be visible in tests and status screens.
