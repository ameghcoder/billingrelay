# Product

BillingRelay is an open-source billing layer between PayPal and a developer's existing app. It
verifies payments, keeps the authoritative record of subscriptions, credits and purchases, optionally
syncs that state one-way into the developer's own Postgres, and uses AI with human approval to set up
billing and investigate failures.

"BillingRelay" is a working name. Naming and trademark availability have not been checked.

## What it is and isn't

It is a software layer that owns integration, event processing, normalized records, access and credit
policy, and delivery into the application database.

It is not a Merchant of Record, bank, fund custodian, marketplace, tax-remittance service, or a builder
for the customer's whole application. Merchants keep their own PayPal accounts. PayPal processes the
payments.

## Audience

An independent developer or small SaaS team that already has an app and a PayPal account, and wants
subscriptions, usage credits or product purchases without maintaining checkout handlers, lifecycle
rules, webhook code and database writes themselves.

## Example merchant

A creator tool sells a monthly Pro membership, a 5,000-credit pack, and a downloadable template with
Standard and Extended license variants. It configures these in BillingRelay or references its existing
catalog from its backend, and the customer pays through PayPal. BillingRelay verifies the payment,
stores normalized records, applies the configured access or credit rule, and delivers the state to the
merchant's database. The app reads its own billing tables; spending credits goes through the BillingRelay
API.

## What the developer gets

| Developer receives | Practical value |
|---|---|
| One API and a thin SDK | PayPal-specific code stays out of the app |
| Stable ID mappings | App users, products, PayPal objects and purchases stay traceable |
| Optional Postgres projection | The app can join local billing records with its users |
| Durable processing and delivery | A callback failure or target outage has a recovery path |
| Understandable setup and traces | An operator can see what is configured and why a record is delayed |
| Self-hostable core | The developer can run it on their own infrastructure |

## Purchase models

| Model | Boundary |
|---|---|
| One-time product | One product/variant per checkout initially; bounded quantity |
| Basic variants | Metadata such as size, color, format, edition or license; configured price |
| Prepaid credit pack | A verified purchase grants integer application credits once |
| Recurring subscription | One simple monthly fixed plan per product |
| Backend quote | The authenticated merchant backend supplies a reviewed one-time price snapshot |

**Schema builder.** Fields: external product ID, name, optional description, kind, variant
ID/attributes, price/currency, benefit rule. Custom fields support text, number/integer, boolean and
enum/select with simple required/range/length limits. It produces reviewable JSON Schema and validated
runtime rules.

**Two input paths, one checkout contract.** Dashboard catalog: resolve product and variant to trusted
stored config. Existing catalog: accept IDs and display metadata from the merchant backend, then create
an immutable quote. The browser never determines the amount.

**Pricing language.** Different product prices are catalog pricing. Attribute-based differences are
variant pricing. Time, customer or demand-driven rules are a later extension.

**Snapshot the purchase.** Store item, variant, quantity, unit amount, currency, benefit rule and config
version at checkout creation. Catalog edits can't change an in-flight or historical purchase.

## Not supported

Payment providers other than PayPal, mixed recurring/one-time carts, inventory, shipping, storefront
builder, tax engine, automatic FX, subscription migration, arbitrary executable schemas, proration,
mid-cycle upgrades, trials, automatic refunds. Shipping, inventory and fulfillment stay in the merchant's
app.

## Later, after the hackathon

- **Disputes and chargebacks:** the most valuable next step. They restrict access the same way a refund does.
- **Invoicing:** fits naturally. A paid invoice is another payment fact through the same flow.
- **Setup diagnostics, limited deterministic pricing rules, broader carts.**
- **Agent payment acceptance:** a merchant's agent requests payment for a task (see `ai-agents.md`).
- **Payouts are a different product.** They move money out, which crosses the "not a marketplace or fund
  custodian" boundary. That's a separate product decision, not a matter of adding events.

## Novelty and validation

Autumn already handles billing and entitlements over Stripe. Unified provider SDKs and Stripe-to-Postgres
sync tools exist. The hypothesis is that PayPal support, flexible inputs, external Postgres delivery and
clear setup are valuable together. A generic wrapper is a weak novelty claim, so show the combined
workflow rather than a count of integrations.

Ask 2–3 developers to show their current integration and a recent payment or access failure, and have one
try the sample app. Record actual installation time and friction; don't invent adoption or savings. After
submission, try three independent installations, and continue toward a business only if repeated usage and
willingness to use a managed option support it. Self-hosting alone doesn't establish demand.
