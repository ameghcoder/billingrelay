# Verification

Test guarantees, not implementation details.

**Source state and credits.** Repeated IDs, different observations for one payment, concurrent workers, changed request payloads, ledger/balance
agreement, competing final-credit usage, one compensation per failed operation.

**Independent destination.** Source and outbox commit together. The scanner recovers an enqueue failure. Target outage and reconnect, lost
acknowledgement, stale versions, repeated delivery and project isolation are exercised. The sample app actually reads its own destination database.

**PayPal and lifecycle.** Actual one-time checkout; supported recurring setup and renewal behaviour; invalid signatures; wrong amount, payee or
environment; authorized-only payment; missing browser return; cancellation/failure and refund-review state.

**AI and user experience.** Valid drafts for all supported pricing models. Missing input becomes a question or explicit assumption. An unsupported
capability stays blocked. A fulfilled record gets no repair. A failed delivery suggests the existing retry. A model outage doesn't stop billing and sync.

| Proof type | What it establishes |
|---|---|
| Real Postgres test | Locks, constraints, concurrency and transactional effects |
| PayPal fixture | Repeatable edge-case interpretation; not actual PayPal execution |
| Real sandbox run | That the configured PayPal path works with actual test objects |
| Clean install | That docs, migrations, worker and sample app are reproducible |
| Browser smoke | That the main flow and status display work end to end |

## Each guarantee and what proves it

Sandbox runs are local, against PayPal sandbox with a real buyer, and are re-run together before the feature freeze (M15). "Injected" means
PayPal's answer was changed on purpose by a preloaded fetch wrapper the app doesn't know about.

| Guarantee | Proven by | Proof type |
|---|---|---|
| A webhook is verified and stored before it's acknowledged; replays, altered bodies and floods change nothing | `checkouts.test.ts` (unknown connection), `processing.test.ts` (same event twice is one row); real events replayed and altered through a tunnel | Real Postgres, sandbox run |
| A billing change and its outbox row commit together | `processing.test.ts`: a refused outbox row undoes the money change, the refund move and the benefits step | Real Postgres, forced rollback |
| One payment, each effect at most once | `processing.test.ts` (20 confirms at once, a capture used twice), `subscriptions.test.ts` (first payment seen 20 times), `credits.test.ts` (a pack grants once); real buyers with two workers and a worker killed mid-way | Real Postgres, sandbox run |
| One usage ID debits once; never below zero; one compensation per debit | `credits.test.ts` (50 spends at once, 20 with one usageId, compensation asked twice at once), `e2e/credits.test.ts` | Real Postgres |
| The ledger adds up | `credits.test.ts`: every account's entries equal its lots, after real purchases, a real refund and races | Real Postgres, sandbox run |
| The destination takes only a newer `source_version`; sync copies balances, never adds | `sync.test.ts` (repeats and late copies ignored, 20 deliveries of one version), a balance copied as computed | Real Postgres (two servers) |
| Destination down, refusing, or killed mid-delivery: converges, one row | `sync.test.ts` (outage uses no attempts, permission taken away mid-way, worker killed on the last attempt); a real purchase with the destination stopped | Real Postgres, sandbox run |
| Money, fulfillment and sync stay separate | `checkouts` API shape; `dashboard.test.ts` ("Paid, not synced"); the demo path: captured and applied while the copy is refused | Real Postgres, sandbox run |
| A retry never charges again; a timeout never authorizes a replacement | Lost answer, hang and the server killed mid-capture on real orders (injected), PayPal's real `ORDER_ALREADY_CAPTURED`; `processing.test.ts` ("unclear" never repeats a capture on its way) | Sandbox run (injected), real Postgres |
| Wrong amount, currency, seller or custom ID grants nothing | `packages/core/src/checkouts.test.ts` (seller, amount, currency mismatches); real orders with PayPal's answer changed (injected); `subscriptions.test.ts` (wrong amount, a subscription that isn't ours) | Fixture, sandbox run (injected) |
| Live is refused everywhere | `paypal-connection.test.ts` (refuses live), `processing.test.ts` (a planted live checkout is never touched), the `live_disabled` checks on every route | Real Postgres |
| Prices come from config or a server quote | `checkouts.test.ts` (price from the live catalog, a tampered body refused), `quotes.test.ts` (can't undercut a catalog price, a draft product refused) | Real Postgres |
| Customer identity is the merchant's `(project, external_customer_id)`, never email | `quotes.test.ts` (quote bound to its customer), `sync.test.ts` (no buyer details copied), `dashboard.test.ts` (no payload or buyer details) | Real Postgres |
| Projects are kept apart | `sync.test.ts` (keeps projects apart), `repairs.test.ts` (another project's row gets no repair), `e2e/isolation.test.ts` (another project's key can't read, spend, compensate, cancel, check or check out this project's records) | Real Postgres |
| Subscriptions: paid time only moves forward; cancel keeps what was paid; a renewal is recorded once | `subscriptions.test.ts`; a real monthly subscription and a real daily-plan renewal recorded by the worker's own scheduled look | Real Postgres, sandbox run |
| The AI can't mark payments, edit balances, run SQL or refund; approval binds to an exact version | `approval.test.ts` (a config changed after approval can't go live), `ai-setup.test.ts` (an unstated price is refused), `mcp.test.ts` (no tool approves or goes live), `investigations.test.ts` (asked for a refund or credits, nothing that refunds or grants) | Real Postgres, real model |
| A repair runs only after approval, once, and never on a changed record | `repairs.test.ts` (five runs at once, stale proposals, a delivered row gets nothing) | Real Postgres |
| A buyer who never returns and an event that never comes are still found | `processing.test.ts`, `repairs.test.ts` (reconciliation picks up an order after a few minutes, never one past its hour); a real approved order with its webhook removed | Real Postgres, sandbox run |
| The model down doesn't stop billing | `e2e/model-outage.test.ts`: with a key OpenAI refuses, AI setup answers 503 `ai_unavailable` while quotes, checkouts and credits answer as they would anyway | Real Postgres, real OpenAI refusal |
| The SDK sends what the routes expect and refuses answers in another shape | `packages/sdk/src/index.test.ts` | Stubbed `fetch` |
| A fresh folder installs and sells | `docs/self-host.md` followed in a clean folder to a real purchase that shows in the example app's own database (M16) | Clean install, sandbox run |

### Not proven

- Denied captures, `SUSPENDED` and failed renewals: never sent by PayPal's sandbox in our runs. They go through the same handling as declines.
- A monthly renewal: a daily plan renewed for real; a monthly one can't be seen before the deadline.
- Currencies other than USD: they pass validation, but no real payment was made in them.
- Hosted: every run above is local. The Render deploy has its own smoke purchase.
