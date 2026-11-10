# Postgres synchronization

One billing backend, API access by default, and an optional copy in the developer's own database.

**Design decision:** BillingRelay owns the authoritative billing records. Destination tables are a one-way, eventually
consistent projection. This is application-level delivery, not Postgres replication or a two-way merge.

## Two ways to read

| | API + server SDK | Optional Postgres sync |
|---|---|---|
| How | The app reads subscriptions, purchases and balances from BillingRelay. No database credentials shared | A worker copies billing state to a dedicated schema. The app reads locally from Postgres or Supabase |
| Tradeoff | API availability and latency; cached state can go stale | Database access and maintenance; a delay between payment and local availability |

## Identity

An internal customer UUID maps to the app's existing user ID. UUID or string external IDs are accepted, unique on
`(project_id, external_customer_id)`. Email is optional contact data, never the join key. UUIDs don't provide authorization or
anonymity. The project comes from the server API key, and the customer comes from the authenticated app session. Never trust a
customer ID from the browser.

```ts
await relay.checkout.create({
  externalCustomerId: session.user.id,
  productId: "pro_monthly",
}); // Proposed server SDK interface
```

## Payment-to-database flow

1. **Create checkout.** Bind project, customer and trusted price to a checkout reference before redirecting to PayPal.
2. **Receive confirmation.** Verify the webhook and durably store it in the inbox before acknowledging. Dedupe provider events and
   logical payment effects.
3. **Commit billing state.** One source transaction applies the subscription or credit change and inserts an outbox update.
4. **Deliver in the background.** A worker writes a versioned snapshot to the destination. It records success only after the
   destination transaction commits; failures stay retryable.
5. **Read the result.** The app uses the SDK or local tables.

## Implementation

1. **Build the source first.** Customers, billing state, credit ledger, inbox, outbox, delivery status.
2. **Provision the destination.** Owner-run migration SQL for a dedicated schema such as `billingrelay`, with a schema version marker.
   If the namespace holds incompatible objects, stop and choose another name. Never overwrite existing tables.
3. **Restrict the connection.** TLS with certificate verification; credentials encrypted at rest and out of logs. Runtime role has only
   `CONNECT`, schema `USAGE` and the required `SELECT/INSERT/UPDATE` on relay tables. `CREATE/DROP` stays with the owner. Restrict outbound
   database hosts.
4. **Fixed projection.** Customers, subscriptions, purchases, access and balances, with project/customer references, `source_version`
   and `synced_at`. Use fully qualified names: `public.subscriptions` stays separate from `billingrelay.subscriptions`.
5. **Repeatable delivery.** Versions increase per source record. Upsert full snapshots, accepting only a newer version. Copy the computed
   balance; never add credits on delivery. After a crash following destination commit, the retry is harmless.
6. **Recover and observe.** Backfill on connection, retry transient failures with backoff and jitter, expose lag, attempts and errors.
   Reconcile current source versions periodically. Keep cancellation/deletion tombstones so stale data can't reappear.

```sql
-- Illustrative guard; key is (project_id, customer_id)
INSERT INTO billingrelay.balances AS b
  (project_id, customer_id, balance, source_version)
VALUES ($1, $2, $3, $4)
ON CONFLICT (project_id, customer_id) DO UPDATE
SET balance = EXCLUDED.balance,
    source_version = EXCLUDED.source_version
WHERE EXCLUDED.source_version > b.source_version;
```

## As built

One destination per deployment, set by `DESTINATION_DATABASE_URL` on the worker only. Rows carry `project_id`, so a per-project setting can
come later. A form that accepts a database URL is an SSRF risk, so there isn't one.

**Setup, once, by the destination's owner.** `pnpm destination:setup` with `DESTINATION_OWNER_URL` (and `DESTINATION_SYNC_PASSWORD` to let
the worker's role log in). It creates schema `billingrelay` and the role `billingrelay_sync`. That role can `SELECT`, `INSERT` and `UPDATE`
its own tables and nothing else: no `DELETE`, `CREATE` or `DROP`. It's plain SQL in `packages/sync-postgres/migrations/`, so it can also be
pasted into an SQL editor. An existing `billingrelay` schema it didn't make stops it before anything changes. Setup accepts no other schema
name yet.

**Tables.** `customers` (your user ID is `external_customer_id`), `purchases` (one per checkout, from its first payment change), `access` (one
per paid purchase that grants access; a refund makes it `restricted`), `subscriptions` (status, `paid_through`, `access_until`,
`cancel_requested`) and `schema_version`. Nothing is ever deleted. Never copied: the buyer's email or name, PayPal's raw events, API keys.
Balances arrive with M11. An unpaid checkout isn't copied, and `expired` isn't a stored status, so `purchases.expires_at` is there instead.
Decide access from `access`. A subscription's access row has `active_until`, which a renewal moves forward; a one-time purchase leaves it empty.

```sql
SELECT 1 FROM billingrelay.access
WHERE external_customer_id = $1 AND access_key = 'pro' AND status = 'active'
  AND (active_until IS NULL OR active_until > now());
```

**Upgrading.** Running `pnpm destination:setup` again applies only the versions a destination doesn't have yet (`002_subscriptions.sql` adds
`subscriptions` and `access.active_until`), keeping every row. Until it's run, the worker reports `not_ready (schema_version_mismatch)` and
waits, delivering nothing.

**Delivery.** An outbox row only says a record changed. The worker sends that record's current state, and every waiting row for it up to that
version is then delivered. It runs on its own queue, so a slow destination can't hold up payments, and it never talks to PayPal.

| What's wrong | Examples | What happens |
|---|---|---|
| Down | Refused connection, timeout, restarting | Nothing is used up. Rows wait; the worker checks again after 5s, 10s, 20s, 40s, then each minute, with jitter |
| Not ready | No schema, wrong version, permission denied, a role that could create things, no TLS | Same wait, with a code saying what to fix. The worker never fixes it itself |
| One row refused | A value the table rejects | That row backs off: 5s, 30s, 2m, 10m, then hourly. After 8 attempts it's `failed`, and the others flow past it |

Only codes are stored, never error text. A destination that isn't on this machine needs TLS with a verified certificate. With no destination set, changes
wait in the outbox, and setting one later delivers them all. A new, empty destination after delivery isn't refilled; that's reconciliation (M14).

## Failure behaviour

| Failure | Expected result |
|---|---|
| Destination offline | Source stays committed; durable delivery waits and retries |
| Target write succeeds, acknowledgement lost | A repeat is a no-op or returns the applied version |
| Old delivery arrives late | Its stale version is ignored |
| Queue enqueue fails | A periodic scan finds unprocessed inbox/outbox work |
| Target rows edited manually | Flag or reconcile divergence; these are managed projections |

## Tradeoffs and boundaries

| Risk / cost | First-version decision |
|---|---|
| Stale local state | Show sync status and lag. Use the authoritative API for credit spending and actions that need current payment state |
| Credential exposure / isolation | Sync is optional. Schema names avoid collisions; role grants and app authorization enforce access. Add project filtering or RLS where needed |
| Existing tables / custom schemas | No automatic mapping or bidirectional writes. Developers read the dedicated tables alongside their data |
| More infrastructure | One destination per project. Custom mappings and a local pull connector are deferred |

**Hosted demo:** use a preconfigured destination. Letting anyone enter a database URL is an SSRF risk that needs careful network
restrictions. Self-hosters may explicitly allow local or private targets.

**Proving it:** source and destination must be independent databases; a same-database view doesn't prove external sync.

**Acceptance checks:** API-only works with no database connection; duplicate and out-of-order delivery is safe; an outage catches up after
recovery; a conflicting schema stays untouched; credit consumption is atomic in BillingRelay.
