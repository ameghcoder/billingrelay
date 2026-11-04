# 0001: Foundations

Status: accepted, 2026-10-28 to 2026-11-04.

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
