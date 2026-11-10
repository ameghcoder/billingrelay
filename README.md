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
- When hosted: `CLIENT_IP_HEADER`, the header your host's proxy sets to the client's IP. Rate limits count per address from it;
  without it, every client shares one count. Never use `X-Forwarded-For`, since clients can set it
- Optional, to copy billing state into your own Postgres: `DESTINATION_OWNER_URL` and `DESTINATION_SYNC_PASSWORD` for the one-time setup, then
  `DESTINATION_DATABASE_URL` as the `billingrelay_sync` role with that password. Leave them empty for API-only

```sh
docker compose up -d --wait   # source database on 5433, destination on 5434
pnpm db:migrate
pnpm destination:setup        # once: the destination's tables and the worker's restricted role
pnpm db:seed                  # creates the one operator and the project
pnpm dev                      # web on http://localhost:3100, plus the worker
```

Sign in at http://localhost:3100/login, then open **PayPal** and enter your sandbox REST app's client ID and secret. Open **Catalog** to add what
you sell, or **AI setup** to describe it and let the AI draft it (needs `OPENAI_API_KEY`). Each save is a new version; you approve a version,
then choose when it goes live. `GET /api/health` reports the databases and the worker.

Open **Developers** to create an API key for your backend. It's shown once. With a product live, your backend can ask for a quote, which keeps its
price even if the catalog changes, and expires:

```sh
curl -X POST http://localhost:3100/v1/quotes \
  -H "Authorization: Bearer $BILLINGRELAY_API_KEY" \
  -H "Idempotency-Key: order-1234" \
  -H "Content-Type: application/json" \
  -d '{ "externalCustomerId": "app-user-42", "productRef": "template", "variantRef": "extended-license" }'
```

Keep the key on your server and take `externalCustomerId` from your own session, never from the browser. Retrying with the same `Idempotency-Key`
returns the same quote. See `docs/api-contract.md`.

To take a payment, add your app's origin under **Developers**, in **Allowed return URLs**, and start a checkout from a quote or the live catalog:

```sh
curl -X POST http://localhost:3100/v1/checkouts \
  -H "Authorization: Bearer $BILLINGRELAY_API_KEY" \
  -H "Idempotency-Key: checkout-1234" \
  -H "Content-Type: application/json" \
  -d '{ "externalCustomerId": "app-user-42", "quoteId": "<quote id>", "returnUrl": "https://app.example.com/billing/return" }'
```

Send the buyer to the `checkoutUrl` it returns, which uses `PUBLIC_BASE_URL`. They come back to your `returnUrl` with `?checkout=<id>`. That redirect proves nothing, so ask
`GET /v1/checkouts/:id` from your backend. In sandbox, approve with a US personal sandbox account. On ngrok's free plan, the buyer first sees one warning page from ngrok.

To host it on Render, see `docs/deploy-render.md`.

`pnpm test` runs the unit tests. `E2E_WRITE_DB=1 pnpm test:invariants` runs the billing invariants against real Postgres; use a throwaway database with no worker running. Setting `DESTINATION_OWNER_URL` to a throwaway destination server adds the sync invariants, which create databases there. With the stack running, `pnpm test:e2e` runs the end-to-end tests. `E2E_WRITE_DB=1` adds the tests that save catalog
versions, API keys and quotes, so use it only on a throwaway database. Adding `E2E_PAYPAL=1`, with `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` set, also makes real, unapproved
sandbox orders.

A subscription starts the same way from a `subscription` product; `POST /v1/subscriptions/:id/cancel` stops renewals and keeps the paid time.
To spend credits before doing the work, and give them back if it fails:

```sh
curl -X POST http://localhost:3100/v1/credits/consume -H "Authorization: Bearer $BILLINGRELAY_API_KEY" -H "Content-Type: application/json" \
  -d '{ "externalCustomerId": "app-user-42", "amount": 10, "usageId": "job-981" }'
curl -X POST http://localhost:3100/v1/usage/job-981/compensate -H "Authorization: Bearer $BILLINGRELAY_API_KEY"
curl http://localhost:3100/v1/customers/app-user-42/billing -H "Authorization: Bearer $BILLINGRELAY_API_KEY"
```

**Credits.** Monthly credits from a subscription last for the paid month: unused ones don't carry over, and a customer who cancels keeps them until
that month ends. Credit packs never expire and are spent after monthly credits.

## Capability matrix

Only capabilities with a recorded proof are marked verified.

| Capability | Status | Proof |
|---|---|---|
| PayPal sandbox OAuth | ✅ verified with a script | Token returned |
| One-time order: create, approve, capture | ✅ verified with a script | Order `0C768617WF029362W`, capture `37L31305X26514342` |
| Duplicate capture is safe | ✅ verified with a script | Same result on the same request ID; `ORDER_ALREADY_CAPTURED` on a new one |
| Webhook signature verification | ✅ verified with a script | 4 real events, all `verification=SUCCESS` |
| Monthly subscriptions: plan, checkout, access, cancel | ✅ verified locally | A real sandbox buyer on a monthly plan BillingRelay made; replayed events, two workers, a worker killed mid-read, cancel through the API with PayPal's real event. `tests/invariants/subscriptions.test.ts`; not yet hosted |
| Subscription renewal observed | ✅ daily plan, through BillingRelay | A daily-plan subscription started through BillingRelay's routes renewed for real (sale posted 5h after its billing time); the worker's own scheduled look recorded it once and moved paid time and access forward. A monthly renewal can't be seen before the deadline |
| Operator login, admin routes protected | ✅ verified locally | `tests/e2e/admin-auth.test.ts` against a production build; not yet hosted |
| PayPal connection: encrypted secret, webhook setup, capability check | ✅ verified locally | Real sandbox, `tests/e2e/paypal-connection.test.ts` against a production build; not yet hosted |
| Catalog: products, variants, prices, versions, activation | ✅ verified locally | `tests/e2e/catalog.test.ts` against a production build; not yet hosted, and no checkout reads it yet |
| Catalog currencies | ⚠️ USD proven with a real payment | EUR, GBP, CAD and AUD pass validation, but no real payment has been made in them |
| Monthly credits expire, packs don't | ✅ verified locally | A real subscription granted its month's credits, ending with its access; expiry and renewal proven in `tests/invariants/credits.test.ts` with time moved |
| API keys and trusted quotes: fixed price, customer binding, expiry, safe retries | ✅ verified locally | `tests/e2e/quotes.test.ts` against a production build; a real payment used one; not yet hosted |
| BillingRelay checkout: real sandbox purchase, one order, one capture | ✅ verified locally | Capture `3GN46362VS501844G` by a real sandbox buyer, `tests/e2e/checkouts.test.ts`; not yet hosted |
| Unknown outcomes never charge twice: lost answer, hang, server killed mid-capture | ✅ verified locally | Lost answer and hang injected on real orders, kill was real; PayPal showed one capture each time |
| Webhook route: verified and stored before acknowledging | ✅ verified locally | Real events through a tunnel, replayed and altered |
| Durable processing: a buyer who never returns is captured, one effect per payment, restarts lose nothing | ✅ verified locally | Real buyers and real events, worker killed with `SIGKILL` mid-way, two workers at once, `tests/invariants/processing.test.ts`; not yet hosted |
| Access benefits and the outbox | ✅ verified locally | Applied once from the snapshot; every change has its outbox row, proven with forced rollbacks |
| Refunds: full or partial moves money to review and restricts access | ✅ verified locally | Real sandbox refunds with their real events. No clawback, by design |
| Denied captures | ⚠️ not seen for real | Handled by the same path as a decline; PayPal's sandbox hasn't sent this event |
| Declined and pending captures | ⚠️ handling verified | Decline used PayPal's mock header; pending was injected |
| Credit ledger | ✅ verified locally | Append-only; every account's entries equal its lots after real purchases, a real refund and races |
| Credit packs and atomic consumption | ✅ verified locally | A real pack purchase granted once; 50 spends at once never overspent; one debit per usage ID; one compensation. Not yet hosted |
| One-way sync to an independent Postgres | ✅ verified locally | A separate Postgres server stopped during a real purchase converged with one row; a worker killed after the destination committed, two workers, a hanging destination, a refused row and a restricted role, `tests/invariants/sync.test.ts`. Not yet hosted, and no TLS destination yet |
| Billing and sync dashboard, customer trace | ✅ verified locally | `tests/e2e/dashboard.test.ts` against a production build with planted rows: "Paid, not synced" in one click, a trace down to the failed attempt's code, no payload or buyer details in any response. Read-only |
| Rate limits and PayPal token reuse | ✅ verified locally | Floods of forged events, wrong keys and sign-ins stop at their limits without blocking other addresses; a real purchase used one token. Per process, and Render's client IP header not yet confirmed |
| AI billing setup (reviewed draft) | ✅ verified locally | The real model drafted a membership with credits, a pack and a two-license product that passed every rule; with no price given it asked. A price it didn't hear is refused in code. Nothing goes live without a person approving that exact version (`tests/e2e/ai-setup.test.ts`, `tests/invariants/approval.test.ts`) |
| Visual flow builder | ✅ verified locally | Drawn from a real AI draft; an edit on the canvas saved a new, unapproved version in the same history (`tests/e2e/flow.test.ts`, `tests/e2e/ai-setup.test.ts`) |
| MCP adapter | ✅ verified locally | The official MCP client drafted a version, read a customer and was refused nothing it's allowed; no tool approves or goes live, MCP and backend keys each refused on the other endpoint (`tests/e2e/mcp.test.ts`) |
| AI investigation and safe retry | ✅ verified locally | The real model named a refused copy's cause and proposed the existing retry; it ran once after approval, and again was refused as stale. Asked for a refund or credits, it proposed nothing (`tests/e2e/investigations.test.ts`, `tests/invariants/repairs.test.ts`) |
| Reconciliation: no event, never returned, rebuilt database | ✅ verified locally | An approved order with no event was found and captured once; "resend everything" refilled an emptied merchant database |

Not supported: providers other than PayPal, tax, inventory, shipping, trials, proration,
mid-cycle upgrades, automatic refunds, currency conversion.
