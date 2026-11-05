# BillingRelay

Open-source billing layer between PayPal and your app. Describe what you sell, approve the
config, take payments through PayPal, and read correct billing state from your own Postgres.

> Sandbox prototype for the PayPal AI Hackathon. No live money. Working name only.

## Run it locally

Needs Node 22.18+, pnpm and Docker.

```sh
pnpm install
cp .env.example .env.local
```

In `.env.local`, set:

- `BETTER_AUTH_SECRET` and `SECRETS_ENCRYPTION_KEY`, each from its own `openssl rand -base64 32`
- `OPERATOR_EMAIL` and `OPERATOR_PASSWORD` (at least 12 characters)
- `PUBLIC_BASE_URL`, the public https address PayPal can reach, such as an ngrok domain

```sh
docker compose up -d --wait   # source database on 5433, destination on 5434
pnpm db:migrate
pnpm db:seed                  # creates the one operator and the project
pnpm dev                      # web on http://localhost:3100, plus the worker
```

Sign in at http://localhost:3100/login, then open **PayPal** and enter your sandbox REST app's client ID and secret. Open **Catalog** to add what
you sell: each save is a new version, and you choose when one goes live. `GET /api/health` reports the databases and the worker.

`pnpm test` runs the unit tests. With the stack running, `pnpm test:e2e` runs the end-to-end tests. `E2E_WRITE_DB=1` adds the tests that save catalog
versions, so use it only on a throwaway database.

**Credits.** Monthly credits from a subscription last for the paid month: unused ones don't carry over, and a customer who cancels keeps them until
that month ends. Credit packs never expire and are spent after monthly credits. The ledger that enforces this arrives with credit packs and usage.

## Capability matrix

Only capabilities with a recorded proof are marked verified.

| Capability | Status | Proof |
|---|---|---|
| PayPal sandbox OAuth | ✅ verified with a script | Token returned |
| One-time order: create, approve, capture | ✅ verified with a script | Order `0C768617WF029362W`, capture `37L31305X26514342` |
| Duplicate capture is safe | ✅ verified with a script | Same result on the same request ID; `ORDER_ALREADY_CAPTURED` on a new one |
| Webhook signature verification | ✅ verified with a script | 4 real events, all `verification=SUCCESS` |
| Monthly fixed subscription plan | ⬜ not verified | |
| Subscription renewal observed | ✅ daily plan only | Subscription `I-937ASKVASBHS`, 7 cycles completed; renewal webhook not captured yet |
| Operator login, admin routes protected | ✅ verified locally | `tests/e2e/admin-auth.test.ts` against a production build; not yet hosted |
| PayPal connection: encrypted secret, webhook setup, capability check | ✅ verified locally | Real sandbox, `tests/e2e/paypal-connection.test.ts` against a production build; not yet hosted |
| Catalog: products, variants, prices, versions, activation | ✅ verified locally | `tests/e2e/catalog.test.ts` against a production build; not yet hosted, and no checkout reads it yet |
| Catalog currencies | ⚠️ USD proven with a real payment | EUR, GBP, CAD and AUD pass validation, but no real payment has been made in them |
| Monthly credits expire, packs don't | ⬜ not built | Rule decided and stated; the ledger comes later |
| BillingRelay checkout, inbox and ledger | ⬜ not built | |
| Credit packs and atomic consumption | ⬜ not built | |
| One-way sync to an independent Postgres | ⬜ not built | |
| AI billing setup (reviewed draft) | ⬜ not built | |
| AI investigation and safe retry | ⬜ not built | |

Not supported: providers other than PayPal, tax, inventory, shipping, trials, proration,
mid-cycle upgrades, automatic refunds, currency conversion.
