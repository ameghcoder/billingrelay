# Architecture

Flow: checkout → verified facts → billing effects → durable delivery → application records

```
Merchant app ──server SDK──▶ Web / checkout API ──▶ PayPal (approve, capture)
                                    │                     │ signed webhook
                                    ▼                     ▼
AI + operator review ──▶    Source Postgres  ◀── Inbox + domain worker
(draft config,              (billing, ledger,    (verify, persist, normalize,
 scoped evidence)            access, outbox)      retry, reconcile)
                                    │
                                    ▼
                               Sync worker ──▶ Merchant Postgres (billingrelay.*)
                               (versioned        app reads local state
                                projections)
```

## Four operational pieces

One web/API app, one persistent Node worker service, one source Postgres, and an independent destination
Postgres. Shared TypeScript domain modules keep logic consistent. pg-boss transports jobs; it is not the
business ledger. A serverless web process doesn't replace the persistent worker.

## Durability boundaries

- Verify an event and persist it before acknowledging receipt.
- An inbox scan recovers any gap in enqueueing.
- Normalized billing/access/ledger changes and the sync outbox entry commit in one source transaction.
- Keep external network calls outside short database locks.
- The inbox stores any verified event type and marks types without a handler as `ignored`, so supporting a
  new event later means subscribing and adding a handler.

Separate statuses: money can be complete while fulfillment fails or delivery is pending. The dashboard shows
each independently. A destination retry never creates another payment.

## Conceptual data model

| Record group | Key content and constraints |
|---|---|
| Identity | Projects, scoped API keys (hashed), customers. Unique project + external app user. Email is descriptive |
| PayPal connection | Merchant, environment, capabilities, webhook identity, encrypted secret reference |
| Catalog | Unchangeable versions, each one JSON document of products, variants, prices and benefits, plus a pointer to the live version |
| PayPal mappings | Internal product/price to PayPal product/plan, scoped by connection and environment |
| Quotes / sessions | Customer, immutable snapshot, expiry, request key, payload hash, PayPal operation |
| Billing facts | Purchases, attempts, payments, subscriptions, paid periods; unique PayPal object identity |
| Processing | Verified inbox, status, attempts, failure code, next retry, processing version |
| Access / credits | Access state, paid-through, credit account, append-only grants/debits/compensations |
| Delivery | Transactional outbox, destination connection, projection version, attempts, cursor |
| AI / audit | Drafts, evidence, action proposals, approval, actor, actual execution outcome |

This is conceptual, not an instruction to build every table before the first working purchase. Internal IDs
are UUIDv7, mapped to app and PayPal IDs. IDs don't replace authorization, operation deduplication or event
ordering.

## Invariants to write first

One eligible payment produces each configured effect at most once. One usage request debits once. Ledger totals
match the operational balance. Every committed source change has its outbox record. An old projection can't
overwrite a newer version. Every lookup and action is project scoped.

## Stack

| Layer | Choice |
|---|---|
| Web / API | Next.js App Router + TypeScript |
| UI | Tailwind + Shadcn; AG Grid Community for complex tables |
| Schema UI | React Hook Form + Zod + JSON Schema |
| Operator auth | Better Auth; seeded operator initially, no public signup |
| Storage | Postgres; Supabase supported; separate destination instance |
| Data access | Drizzle migrations; explicit SQL for critical transactions |
| Jobs | Persistent Node worker + pg-boss |
| Payments | PayPal REST APIs |
| AI | AI SDK, schema-validated tools, configurable tool-capable model |
| Verification | Vitest + real Postgres integration tests; Playwright smoke |
| Packaging / hosting | pnpm workspace + Docker Compose; Render hosted demo |

Pin compatible stable versions, commit the lockfile and use a supported Node LTS.

## Operations baseline

Worker heartbeat, pending age, exhausted jobs, unresolved payments, failed delivery count and last target update.
Health checks, redacted logs, migration instructions, backups and a safe restart process.
