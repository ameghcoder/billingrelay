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
you sell: each save is a new version, and you choose when one goes live. `GET /api/health` reports the databases and the worker.

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

`pnpm test` runs the unit tests. `E2E_WRITE_DB=1 pnpm test:invariants` runs the billing invariants against real Postgres; use a throwaway database with no worker running. Setting `DESTINATION_OWNER_URL` to a throwaway destination server adds the sync invariants, which create databases there. With the stack running, `pnpm test:e2e` runs the end-to-end tests. `E2E_WRITE_DB=1` adds the tests that save catalog
versions, API keys and quotes, so use it only on a throwaway database. Adding `E2E_PAYPAL=1`, with `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` set, also makes real, unapproved
sandbox orders.

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
| API keys and trusted quotes: fixed price, customer binding, expiry, safe retries | ✅ verified locally | `tests/e2e/quotes.test.ts` against a production build; a real payment used one; not yet hosted |
| BillingRelay checkout: real sandbox purchase, one order, one capture | ✅ verified locally | Capture `3GN46362VS501844G` by a real sandbox buyer, `tests/e2e/checkouts.test.ts`; not yet hosted |
| Unknown outcomes never charge twice: lost answer, hang, server killed mid-capture | ✅ verified locally | Lost answer and hang injected on real orders, kill was real; PayPal showed one capture each time |
| Webhook route: verified and stored before acknowledging | ✅ verified locally | Real events through a tunnel, replayed and altered |
| Durable processing: a buyer who never returns is captured, one effect per payment, restarts lose nothing | ✅ verified locally | Real buyers and real events, worker killed with `SIGKILL` mid-way, two workers at once, `tests/invariants/processing.test.ts`; not yet hosted |
| Access benefits and the outbox | ✅ verified locally | Applied once from the snapshot; every change has its outbox row, proven with forced rollbacks |
| Refunds: full or partial moves money to review and restricts access | ✅ verified locally | Real sandbox refunds with their real events. No clawback, by design |
| Denied captures | ⚠️ not seen for real | Handled by the same path as a decline; PayPal's sandbox hasn't sent this event |
| Declined and pending captures | ⚠️ handling verified | Decline used PayPal's mock header; pending was injected |
| Credit ledger | ⬜ not built | A paid credit pack stays `fulfillment: pending` until it exists |
| Credit packs and atomic consumption | ⬜ not built | |
| One-way sync to an independent Postgres | ✅ verified locally | A separate Postgres server stopped during a real purchase converged with one row; a worker killed after the destination committed, two workers, a hanging destination, a refused row and a restricted role, `tests/invariants/sync.test.ts`. Not yet hosted, and no TLS destination yet |
| Rate limits and PayPal token reuse | ✅ verified locally | Floods of forged events, wrong keys and sign-ins stop at their limits without blocking other addresses; a real purchase used one token. Per process, and Render's client IP header not yet confirmed |
| AI billing setup (reviewed draft) | ⬜ not built | |
| AI investigation and safe retry | ⬜ not built | |

Not supported: providers other than PayPal, tax, inventory, shipping, trials, proration,
mid-cycle upgrades, automatic refunds, currency conversion.
