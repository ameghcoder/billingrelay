# API contract

Status: **proposed (M00)**. Shapes become Zod schemas in M01; this doc stays the readable summary.

## Conventions

- JSON over HTTPS. Amounts are integer minor units (`1900` = USD 19.00) with an ISO 4217 `currency`.
- Internal IDs are UUIDv7. The merchant's own user ID is `externalCustomerId` (string, 1–128 chars).
- Every mutating `/v1` call takes an `Idempotency-Key` header. The key, a hash of the normalized
  payload and the result are stored. The same key with the same payload returns the stored result;
  the same key with a different payload returns `409 idempotency_conflict`.
- Errors: `{ "error": { "code": "snake_case", "message": "...", "details": {} } }`.

| Status | Meaning |
|---|---|
| 400 | Request failed validation |
| 401 | Missing or invalid credential |
| 403 | Credential valid but not allowed (wrong project, wrong environment) |
| 404 | Not found within this project |
| 409 | Idempotency conflict, or state conflict (e.g. an active subscription already exists) |
| 422 | Valid request a business rule rejects (insufficient credits, expired quote) |
| 502 | PayPal call failed; the outcome is known to be "not done" |
| 503 | PayPal outcome unknown; the operation is recorded as unresolved, never retried as a new charge |

## Merchant backend (`Authorization: Bearer <project API key>`)

The API key determines the project and environment (sandbox/live). The merchant backend derives
`externalCustomerId` from its own authenticated session. It never forwards one from the browser.

| Operation | Purpose |
|---|---|
| `POST /v1/quotes` | Immutable one-time price snapshot: customer, items, quantity, amount, currency, expiry. |
| `POST /v1/checkouts` | Start checkout from `{ productRef, variantRef? }` or `{ quoteId }`, plus `externalCustomerId` and `returnUrl` (allowlisted). Returns `{ id, checkoutUrl }`. |
| `GET /v1/checkouts/:id` | Money, fulfillment and sync status kept separate, plus the safe next action. |
| `GET /v1/customers/:externalCustomerId/billing` | Purchases, subscriptions, access, credit balance, `version`. |
| `POST /v1/subscriptions/:id/cancel` | Cancel at PayPal; access remains until `paidThrough`. |
| `POST /v1/credits/consume` | Atomic debit: `{ externalCustomerId, amount, usageId }`. The same `usageId` returns the prior result. |
| `POST /v1/usage/:usageId/compensate` | One compensation linked to the original debit. |

Checkout status shape:

```json
{
  "id": "0193…",
  "money": "pending | approved | captured | failed | unresolved | refund_review",
  "fulfillment": "pending | applied | restricted | failed",
  "sync": "not_configured | pending | delivered | failed",
  "nextAction": "redirect | wait | none | contact_support"
}
```

## Hosted checkout (browser, no credentials)

| Route | Purpose |
|---|---|
| `GET /checkout/:id` | Hosted page. Loads the stored snapshot and starts PayPal approval. |
| `GET /checkout/:id/return` | PayPal return. Shows *pending* until the server confirms capture; never grants benefits itself. |

## PayPal webhooks

`POST /webhooks/paypal/:connectionId`: verify the signature for that connection's webhook ID,
store the event in the inbox, then return `200`. No billing logic, AI or destination write happens
inside this request.

## Health (public)

`GET /api/health` returns `{ source, destination, worker }` and nothing else: `ok` or `down` for each database (`not_configured`
when no destination is set), and `ok` or `stale` for the worker. It returns `200` when healthy, `503` otherwise.

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
| `GET /admin/config/drafts` | Saved catalog versions, newest first, with which one is live. |
| `POST /admin/config/drafts` | `{ baseVersion, config }`, the whole catalog. Saves it as a new version and returns `201 { id, version }`. `400 invalid_config` names each field in `details.fields` and stores nothing. `409 version_conflict` returns `latestVersion` if `baseVersion` is no longer the latest. Doesn't change what's live. |
| `GET /admin/config/drafts/:id` | One version: its stored config and a JSON Schema for each product's attributes. |
| `POST /admin/config/drafts/:id/activate` | Makes that version live, after checking the rules again. `422 config_rejected` leaves the live version as it was; `404` for a version outside this project or environment. M12 puts approval in front of this. |
| `POST /admin/config/drafts/:id/validate` | Schema and capability validation, plus a fixture preview labelled as simulation. |
| `POST /admin/config/drafts/:id/approve` | Approval bound to project, environment and exact draft version. |
| `POST /admin/config/drafts/:id/apply` | Create PayPal products/plans idempotently, then activate. Resumes after partial failure. |
| `POST /admin/sync/deliveries/:id/retry` | Retry only a known, eligible failed delivery. Audited. |
| `POST /admin/investigations` | Scoped evidence plus a typed proposal. No mutations. |
| `POST /admin/actions/:id/approve` | Approve a proposed repair. |
| `POST /admin/actions/:id/execute` | Recheck state and version, run a supported handler, record the actual outcome. |

The AI tools and the MCP adapter call these same backend operations with the same permissions.
