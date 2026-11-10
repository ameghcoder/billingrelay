# 0001: Foundations

Status: accepted, 2026-10-28 to 2026-11-05.

1. **PayPal is the only payment provider.** Keep PayPal code in `packages/providers/paypal` so core logic and tests don't depend on PayPal's API
   details, but don't build a generic provider layer that only one provider would use.
2. **Idempotency uses an `Idempotency-Key` header** on mutating `/v1` calls. It's the common convention and works the same way on every POST.
3. **Billing lookup is keyed on the app's own user ID** (`GET /v1/customers/:externalCustomerId/billing`), because the merchant backend doesn't know our
   internal UUID.
4. **An unknown PayPal outcome returns `503`** and records the operation as unresolved. It's never retried as a new charge.
5. **Destination sync is one-way and versioned.** BillingRelay stays authoritative; credits are always spent through its API.
6. **The hosted demo uses a preconfigured destination database.** Accepting arbitrary database URLs is an SSRF risk.
7. **The inbox stores any verified event type**, and marks types without a handler as `ignored`. Supporting a new event later only needs a subscription and a handler.
8. **The webhook subscribes to 9 specific events, not "All".** See `../paypal.md`.
9. **Payouts are out of scope.** They'd change what the product is. Invoicing and disputes would extend it.
10. **Committed docs never point outside the repo.** Anything worth keeping is written into `docs/`.
11. **The AI agents use OpenAI's GPT-5 family through the AI SDK**, with the model name set in config.
12. **The project is MIT licensed.**
13. **A catalog version is one JSON document, not product, variant and price tables.** Stored versions stay unchangeable, and approval can bind to one exact
    version. SQL can't join on a product, but each purchase keeps its own snapshot, so reports don't need to.
14. **Monthly credits last for the paid month, and credit packs never expire.** It stops unused credits piling up without taking anything the customer paid
    for. See `../billing-rules.md`.
15. **A merchant's backend can name a one-time price, but can't grant credits with it.** Developers with their own catalog need this, and the API key is the
    line of trust. Credits come only from a reviewed catalog, so a leaked key can't create them.
16. **A quote never changes and has no stored status.** Removing a product doesn't cancel its open quotes; they run out within 60 minutes. Expiry is worked out
    from the database's clock on each read.
17. **API keys are stored as SHA-256 hashes.** Slow hashes protect guessable passwords, and these are 256 random bits checked on every request.
18. **The PayPal order is created on the Pay click, and a checkout lasts 1 hour.** An abandoned checkout leaves nothing at PayPal, and starting one doesn't depend on
    PayPal being up. A buyer who approves after the hour isn't charged, because nothing is charged until our capture.
19. **One quote gets one checkout, ever.** It's simple and impossible to pay twice, at the cost of one extra call when a checkout fails or expires.
20. **The webhook route only verifies and stores.** A buyer who approves and never returns isn't captured until the worker handles the stored event, or they reopen the
    link. Capturing inside the request would put billing logic before the acknowledgement.
21. **The stored row is the job, and pg-boss only wakes the worker.** A lost or repeated job can't lose or repeat work, and "stored but never queued" can't happen. The cost is a few seconds' delay.
22. **A webhook is a nudge.** The worker re-reads the order from PayPal instead of acting on the event. It costs a call per event, and keeps one path that can say `captured`.
23. **Money and benefits commit separately.** A merchant polling may see `captured` with `fulfillment: pending` for a few seconds, but a failure applying benefits can't hide that money arrived.
24. **`next_attempt_at` is both the retry time and the lease.** Claiming pushes it forward, so a killed worker's event comes back by itself, with no second column to keep in step.
25. **A refund goes to review whatever its size.** Partial refunds need a policy nobody has decided, and restricting access is the safe direction.
26. **One destination per deployment, from an env var, held only by the worker.** A form that accepts database URLs is an SSRF risk, and the
    web app never needs the merchant's login. A per-project setting can come later, because every row carries `project_id`.
27. **Delivery sends a record's current state, and the destination keeps only a newer version.** Repeats, late jobs, two workers and a lost
    acknowledgement all need nothing more than that one `WHERE`.
28. **A destination outage uses up no attempts.** Only a row the destination refuses counts towards `failed`, so a long outage still catches up by itself.
29. **The worker refuses a destination role that could create objects.** A wrong URL can't let a bug damage the merchant's database.
30. **Rate limits are in memory, per web process, and count only failures where success must never be refused.** One Render instance makes
    this exact; a shared store waits until there are several. Webhooks and `/v1` key checks count refusals, so real PayPal events and valid
    keys never use up a limit; with a trusted address, someone else's flood doesn't block them either.
31. **The client's address comes only from one header the deployment names.** Any header a client can send, such as `X-Forwarded-For`, would
    let it pick a new address on every try. Without one, everyone shares a single count, which fails closed.
32. **PayPal tokens are reused in memory, keyed by a hash of the credentials.** A new secret can't get an old token, a `401` drops the token
    as a safe-to-retry failure, and the "check connection" button always asks PayPal for a new one.
33. **On Render, the source database takes no outside connections, and migrations run by hand from the web service's shell.** Nothing
    migrates on deploy, so a migration is always a step someone chose. Render's health check isn't used for routing, because health includes the worker.
34. **A TLS destination's CA is a file named in the URL (`sslrootcert`), not code.** On Render it's a secret file. node-postgres reads it
    the same way everywhere, and the worker still refuses any URL without verified TLS.
35. **A subscription's facts come from PayPal's subscription and its transaction list, never from an event.** Every path (event, return,
    worker) runs the same read, and one row per sale ID makes repeats harmless. Access ends by time (`active_until`), so no job has to run.
36. **Plans are made at PayPal the first time anyone buys at a price, not when a catalog goes live.** Going live stays a database step, and a
    new price is a new plan, so no subscriber's price changes. PayPal's subscription APIs didn't honour `PayPal-Request-Id` in sandbox, so a
    lost answer can leave an unused plan or an unapproved subscription at PayPal. Neither can charge anyone: no buyer ever gets its link.
37. **Access runs 24 hours past PayPal's next billing time, and late approvals are honoured.** Renewals post hours late, and PayPal charges
    when the buyer approves, whatever our checkout's hour says.
38. **Credits are lots plus an append-only ledger, locked per customer.** A lot per payment makes "one grant per payment" a unique key, and
    knowing which lot a debit took from lets a compensation give back exactly that and a refund restrict exactly that pack.
39. **Spending checks end times itself; the expiry sweep only records.** A late worker can never let a lapsed month's credits be spent.
40. **Private-network destinations may skip TLS, only on the operator's explicit `DESTINATION_PRIVATE_NETWORK=1`, and only for private hosts.**
    The hosted demo's merchant database and a Docker self-host live on private networks whose internal names have no public certificate.
41. **The AI can't pick a price.** A deterministic check refuses any price or credit amount the person didn't write, so a prompt can't be
    talked around it, and the agent's tools can read and check but not save. A person saves, approves an exact version (by its config hash),
    and makes it live.
42. **MCP clients get their own kind of key and no tool that approves or goes live.** A leaked backend key can't edit the catalog, a leaked MCP
    key can't take payments, and "only a person makes it live" holds because the capability doesn't exist on that surface.
