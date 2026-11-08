# API contract

Status: **proposed (M00)**. Shapes become Zod schemas in M01; this doc stays the readable summary.

## Conventions

- JSON over HTTPS. Amounts are integer minor units (`1900` = USD 19.00) with an ISO 4217 `currency`.
- Internal IDs are UUIDv7. The merchant's own user ID is `externalCustomerId` (string, 1–128 chars).
- Every call that creates something on `/v1` takes an `Idempotency-Key` header: 1 to 255 printable characters, no spaces. The key,
  a hash of the normalized payload and the result are stored. The same key with the same payload returns the stored result;
  the same key with a different payload returns `409 idempotency_conflict`. JSON key order and a left-out default don't count
  as different. A refused request stores nothing, so its key can be used again.
- Unknown fields are refused, not ignored. `/v1` sends no CORS headers, so a website's script can't call it.
- Errors: `{ "error": { "code": "snake_case", "message": "...", "details": {} } }`. A validation error lists each field in `details.fields`.

| Status | Meaning |
|---|---|
| 400 | Request failed validation |
| 401 | Missing or invalid credential |
| 403 | Credential valid but not allowed (wrong project, wrong environment) |
| 404 | Not found within this project |
| 409 | Idempotency conflict, or state conflict (e.g. an active subscription already exists) |
| 413 | Request body over 64 KB |
| 422 | Valid request a business rule rejects (insufficient credits, expired quote) |
| 429 | `rate_limited`: too many requests. `Retry-After` gives the seconds to wait |
| 502 | PayPal call failed; the outcome is known to be "not done" |
| 503 | PayPal outcome unknown; the operation is recorded as unresolved, never retried as a new charge |

## Merchant backend (`Authorization: Bearer <project API key>`)

The API key determines the project and environment (sandbox/live). The merchant backend derives
`externalCustomerId` from its own authenticated session. It never forwards one from the browser.

| Operation | Purpose |
|---|---|
| `POST /v1/quotes` | Immutable one-time price snapshot: customer, one item, quantity, amount, currency, benefits, expiry. `201` when created, `200` for a retry. See below. |
| `POST /v1/quotes/:id/check` | `{ externalCustomerId }`. Returns the stored quote if this customer can still use it. `422 quote_customer_mismatch`, `422 quote_expired`, `404` outside this project or environment. Checkout applies the same rule. |
| `POST /v1/checkouts` | Start checkout from a quote or the live catalog. `201` when created, `200` for a retry. See below. |
| `GET /v1/checkouts/:id` | Money, fulfillment and sync status kept separate, plus the safe next action. Read-only, with no PayPal call. |
| `GET /v1/customers/:externalCustomerId/billing` | Purchases, subscriptions, access, credit balance, `version`. |
| `POST /v1/subscriptions/:id/cancel` | Cancel at PayPal; access remains until `paidThrough`. |
| `POST /v1/credits/consume` | Atomic debit: `{ externalCustomerId, amount, usageId }`. The same `usageId` returns the prior result. |
| `POST /v1/usage/:usageId/compensate` | One compensation linked to the original debit. |

A quote takes one of two forms, plus optional `quantity` (default 1), `expiresInSeconds` (60 to 3600, default 1800) and `metadata`
(up to 20 text values, stored for tracing and never acted on):

```jsonc
// Price from the live catalog. Sending a price here returns 400.
{ "externalCustomerId": "app-user-42", "productRef": "template", "variantRef": "extended-license" }

// The merchant's own catalog: its backend names the price. One-time only. `benefits` is optional: one access benefit or none, never credits.
{ "externalCustomerId": "app-user-42", "item": { "ref": "poster-42", "name": "Poster #42" }, "unitAmount": 1500, "currency": "USD" }
```

Refusals that store nothing, all `422`: `no_live_catalog`, `unknown_product`, `unknown_variant`, `variant_required` (the product has several
variants), `not_quotable` (a subscription), `quantity_too_large`, `amount_too_large` (the total is over 99,999,999 minor units),
`product_in_catalog` (a merchant-priced `item.ref` matches a live catalog product).

```json
{
  "id": "0193…",
  "externalCustomerId": "app-user-42",
  "status": "open | expired",
  "expiresAt": "2026-11-06T10:30:00.000Z",
  "snapshot": {
    "source": "catalog | merchant",
    "catalogVersion": 4,
    "product": { "ref": "template", "name": "Creator template", "kind": "one_time" },
    "variant": { "ref": "extended-license", "name": "Extended", "attributes": { "license": "extended" } },
    "quantity": 1,
    "unitAmount": 2900,
    "amount": 2900,
    "currency": "USD",
    "benefits": [{ "kind": "access", "key": "commercial-use" }],
    "metadata": {}
  }
}
```

`catalogVersion` and `variant` are `null` for a merchant-priced quote. `benefits` are per unit. A retry returns the same quote even after
it expires, marked `expired`; a new price needs a new `Idempotency-Key`.

A checkout takes one of two forms, and `returnUrl` is required on both:

```jsonc
// From a quote, which already holds the price. A quote gets one checkout, ever.
{ "externalCustomerId": "app-user-42", "quoteId": "0193…", "returnUrl": "https://app.example.com/billing/return" }

// Straight from the live catalog, by the same rules as a quote. `quantity` and `metadata` are optional. Sending a price returns 400.
{ "externalCustomerId": "app-user-42", "productRef": "template", "variantRef": "extended-license", "returnUrl": "https://app.example.com/billing/return" }
```

Refusals that store nothing: the quote's own `422` codes; `404` for a quote outside this project or environment; `409 quote_used`, with
`details.checkoutId`; `422 return_url_not_allowed`, unless the origin is under Developers, in Allowed return URLs; `422 paypal_not_connected`;
`422 public_url_invalid`.

A checkout lasts 1 hour from creation, however close its quote was to expiring. The response to create and read:

```json
{
  "id": "0193…",
  "externalCustomerId": "app-user-42",
  "checkoutUrl": "https://billing.example.com/checkout/0193…",
  "expiresAt": "2026-11-06T10:30:00.000Z",
  "money": "pending | approved | captured | failed | expired | unresolved | refund_review",
  "fulfillment": "pending | applied | restricted | failed",
  "sync": "not_configured | pending | delivered | failed",
  "nextAction": "redirect | wait | none | contact_support",
  "snapshot": {},
  "paypal": { "orderId": null, "captureId": null }
}
```

| `money` | Meaning | `nextAction` |
|---|---|---|
| `pending` | Not approved, as far as we know | `redirect` |
| `approved` | PayPal says approved, or its capture is pending | `wait` |
| `captured` | PayPal says completed, and the amount, currency, seller and reference all match | `none` |
| `failed` | Declined, or the order is gone. No money moved, so a new checkout is fine | `none` |
| `expired` | Past its hour, with no capture ever sent. Worked out on read, never stored | `none` |
| `unresolved` | The outcome is unknown, or something didn't match. Don't start another payment | `contact_support` |
| `refund_review` | PayPal reported a refund of this capture, full or partial. Access is restricted until a person decides | `contact_support` |

| `fulfillment` | Meaning |
|---|---|
| `pending` | Benefits aren't applied yet. Normal for a few seconds after `captured`, and for a credit pack until the ledger exists (M11) |
| `applied` | Everything the snapshot promised is applied, including a purchase with nothing to apply |
| `restricted` | A refund stopped them. Any grant from this payment is restricted |
| `failed` | Reserved. Nothing sets it yet: a failure to apply is retried and stays `pending` |

| `sync` | Meaning |
|---|---|
| `not_configured` | No destination database is set up. The API is the only way to read billing state |
| `pending` | Not in the merchant's database yet: waiting, retrying, or the destination is down. Also a checkout nothing has happened to, which is never copied |
| `delivered` | The merchant's database has every change to this checkout and its access |
| `failed` | The destination refused one of its changes 8 times. It stays visible until someone retries it |

Money, fulfillment and sync are separate on purpose: `captured` with `pending` means the money arrived and the benefits are still on their way.
Sync never affects money: a destination that's down only delays the copy.

## Hosted checkout (browser, no credentials)

| Route | Purpose |
|---|---|
| `GET /checkout/:id` | Hosted page: the item and total. Reopening the link confirms any existing order first. Never shows the customer ID, metadata or PayPal IDs. |
| `GET /checkout/:id/return` | PayPal return. Shows *confirming* until the server has PayPal's answer. Its query string is ignored, and it never grants benefits. |
| `POST /checkout/:id/pay` | Makes the checkout's one PayPal order, or reuses it, and returns `{ approvalUrl }`. `502` if PayPal refuses and `503` if it can't be reached; both leave it pending. |
| `POST /checkout/:id/confirm` | Reads the order at PayPal, checks it, captures it and checks the capture. Safe to repeat. `503` when PayPal's answer is unknown. |

Holding the link is the only credential. A GET never changes anything, and anyone can call these two POSTs, because they only ever advance a
checkout toward what PayPal itself reports.

## Rate limits

Per web process, in memory, in one-minute windows. "Address" is the client's IP from the one header named by `CLIENT_IP_HEADER`.
Without it, every client shares one count.

| Route | Counted per | Limit |
|---|---|---|
| `/v1/*` with a valid key | key | 600 |
| `/v1/*` refused for its key | address | 120 refusals, then every request from it gets `429` |
| `POST /checkout/:id/pay` | address and checkout | 10 |
| `POST /checkout/:id/confirm` | address and checkout | 20 (the page confirms up to 8 times per load) |
| `GET /checkout/:id` and `/return` | address | 60. The page says so, since a page can't answer `429` |
| `POST /webhooks/paypal/:connectionId` | address and connection, events PayPal refused | 30 refusals, then `429` before any PayPal call. PayPal resends anything not `2xx`, so a real event caught in it arrives later |
| Operator sign-in | Better Auth's own limit, on the same address | |

## PayPal webhooks

`POST /webhooks/paypal/:connectionId`: verify the signature for that connection's webhook ID,
store the event in the inbox, then return `200`. No billing logic, AI or destination write happens
inside this request.

`404` for an unknown connection, `413` over 256 KB, `400 not_verified` for anything PayPal doesn't verify, `429` after 30 of those in a minute,
and `503` when PayPal can't answer, so it sends the event again. The same event ID stores one row.

The worker reads stored events afterwards. An event only says which checkout to look at: the worker asks PayPal for the facts, using the same
code as `/confirm`. Stored events end as `processed`, `ignored` (nothing of ours, or a type with no handler yet) or `failed` after 8 attempts.

## Health (public)

`GET /api/health` returns `{ source, destination, worker }` and nothing else: `ok` or `down` for the source, `ok` or `stale` for the worker,
and the destination's state as the worker last saw it (`not_configured`, `checking`, `ok`, `down` or `not_ready`; `unknown` while the source is down). It returns `200` when the
source and worker are healthy, `503` otherwise. The destination never makes it `503`: a merchant's database being down mustn't get our app restarted.

## Operator (Better Auth session)

Without a session, `/admin` pages redirect to `/login`, and `/admin` API routes return `401 unauthorized`. There is no signup; the one
operator is seeded. `POST /api/auth/sign-in/email` and `POST /api/auth/sign-out` are Better Auth's own routes.

Non-GET `/admin` routes also require an `Origin` header matching `BETTER_AUTH_URL`, otherwise `403 forbidden_origin`. Only `sandbox` can be
used as an environment: `live` returns `422 live_disabled` before any PayPal call.

| Operation | Purpose |
|---|---|
| `GET /admin/me` | The signed-in operator. |
| `GET /admin/paypal/connections` | Safe readback: masked client ID, webhook status, capabilities, last check. Never the secret. |
| `PUT /admin/paypal/connections/:environment` | Check credentials with PayPal, encrypt and save the secret, set up the webhook, run the check. `422` if PayPal rejects them and `503` if it can't be reached; both save nothing. |
| `POST /admin/paypal/connections/:environment/check` | Read-only health and capability check. |
| `POST /admin/paypal/connections/:environment/webhook` | Set up the webhook again (safe to repeat), then run the check. |
| `GET /admin/developers/api-keys` | API keys: name, last 4 characters, status. Never the key or its hash. |
| `POST /admin/developers/api-keys` | `{ name }`. Returns `201` with the full `key`, the only time it's ever shown. Only its SHA-256 hash and last 4 characters are stored. |
| `POST /admin/developers/api-keys/:id/revoke` | Stops the key on its next request. Safe to repeat. Quotes it created stay as they are. |
| `GET /admin/developers/return-origins` | Origins a checkout's `returnUrl` may use. |
| `POST /admin/developers/return-origins` | `{ origin }`, such as `https://app.example.com`: HTTPS, except `http://localhost`, with no path. Safe to repeat. |
| `DELETE /admin/developers/return-origins/:id` | New checkouts can't use it. Ones already started keep their return address. Safe to repeat. |
| `GET /admin/config/drafts` | Saved catalog versions, newest first, with which one is live. |
| `POST /admin/config/drafts` | `{ baseVersion, config }`, the whole catalog. Saves it as a new version and returns `201 { id, version }`. `400 invalid_config` names each field in `details.fields` and stores nothing. `409 version_conflict` returns `latestVersion` if `baseVersion` is no longer the latest. Doesn't change what's live. |
| `GET /admin/config/drafts/:id` | One version: its stored config and a JSON Schema for each product's attributes. |
| `POST /admin/config/drafts/:id/activate` | Makes that version live, after checking the rules again. `422 config_rejected` leaves the live version as it was; `404` for a version outside this project or environment. M12 puts approval in front of this. |
| `POST /admin/config/drafts/:id/validate` | Schema and capability validation, plus a fixture preview labelled as simulation. |
| `POST /admin/config/drafts/:id/approve` | Approval bound to project, environment and exact draft version. |
| `POST /admin/config/drafts/:id/apply` | Create PayPal products/plans idempotently, then activate. Resumes after partial failure. |
| `GET /admin/sync` | The destination's state and a code for what's wrong, since when, pending and failed counts, lag (age in seconds of the oldest change not yet delivered), the last delivery and the last 20 attempts. Read from our own database. |
| `POST /admin/sync/deliveries/:id/retry` | Retry only a known, eligible failed delivery. Audited. |
| `POST /admin/investigations` | Scoped evidence plus a typed proposal. No mutations. |
| `POST /admin/actions/:id/approve` | Approve a proposed repair. |
| `POST /admin/actions/:id/execute` | Recheck state and version, run a supported handler, record the actual outcome. |

The AI tools and the MCP adapter call these same backend operations with the same permissions.
