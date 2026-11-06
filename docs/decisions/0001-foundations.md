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
