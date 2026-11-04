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
