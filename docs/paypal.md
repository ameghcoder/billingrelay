# PayPal behaviour

What we rely on, and what was actually observed in sandbox (M00, Oct–Nov 2026). Recheck before any live use.

## Adapter surface

Capabilities, create checkout, inspect payment, create/cancel subscription, verify event, normalize observation.
Unsupported operations return explicit errors. Keep raw PayPal state and object references next to normalized fields.

- One-time: create order, buyer approval, server capture, confirm the capture completed.
- Keep order, capture, subscription and renewal payment IDs.
- Use stable `PayPal-Request-Id` values on supported calls, and keep our own records as well.
- Subscription lifecycle events and subscription payment events are different things.
- A timeout never authorizes a replacement charge: inspect the known operation. If the outcome can't be proven, mark it
  unresolved for review.
- Simulator events are mock data with verification limits. They are never proof of a real capture.

## Webhook events we subscribe to

| Event | Meaning for us |
|---|---|
| `CHECKOUT.ORDER.APPROVED` | Buyer approved; capture on the server |
| `PAYMENT.CAPTURE.COMPLETED` | One-time payment confirmed; triggers benefits |
| `PAYMENT.CAPTURE.DENIED` | Payment failed; no benefits |
| `PAYMENT.CAPTURE.REFUNDED` | Refund; access goes to review |
| `BILLING.SUBSCRIPTION.ACTIVATED` | Subscription started |
| `BILLING.SUBSCRIPTION.CANCELLED` | Cancelled; access stays until paid-through |
| `BILLING.SUBSCRIPTION.SUSPENDED` | Suspended; state shows as restricted |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | Renewal failed; no new paid period |
| `PAYMENT.SALE.COMPLETED` | Subscription payment including renewals; extends access |

We don't select "All": unhandled types add noise to the inbox, traces and AI evidence.

## Connection

The operator enters a sandbox client ID and secret at `/admin/paypal`. Nothing is saved until PayPal accepts them.

- **Secret:** AES-256-GCM with `SECRETS_ENCRYPTION_KEY`, bound to the project and environment, so a value copied to another record won't
  decrypt. No API returns it. If the key is lost, the operator enters the secret again.
- **Webhook:** BillingRelay sets it up at `PUBLIC_BASE_URL/webhooks/paypal/<connection ID>`. It looks for that exact URL first, so repeating
  it or retrying after a timeout leaves one webhook. It never changes any other webhook on the PayPal app.
- **Capabilities** come from the scopes on the access token: `services/payments/payment/authcapture` (one-time checkout),
  `services/subscriptions` and `services/applications/webhooks`.
- **Addresses:** PayPal's API addresses are constants in the client, picked by each connection's `environment`. They aren't env vars, because
  one deploy can hold both environments, and a wrong value would send real credentials to the wrong host.
- **Live is disabled.** The API refuses `live` before any call, and `withSandbox` in `apps/web/lib/paypal-routes.ts` is that gate. Enabling live
  also means removing the `"sandbox"` values in `saveConnection` and `getSandboxConnection`, and it needs its own review and check.

## Checkout

- **Create:** `custom_id` is the checkout ID, and `PayPal-Request-Id` is `order-<checkout ID>`. `Prefer: return=representation` makes the answer include
  `payee.merchant_id` and `custom_id`. The status is `PAYER_ACTION_REQUIRED` and the approval link's `rel` is `payer-action`.
- **Capture:** `PayPal-Request-Id` is `capture-<order ID>`. Order and capture are both checked against the stored snapshot before anything counts as paid.
- **Seller check:** PayPal gives no other way to read our seller ID here (`userinfo` has no `payer_id`), so the check compares with the `merchant_id` PayPal named when
  the order was created. It catches a change between order and capture, not a wrong first answer. We never set the seller ourselves.
- **Declines:** only a known list of capture refusals, such as `INSTRUMENT_DECLINED`, counts as `failed`. Any other refusal stays `unresolved`, because it doesn't prove no money moved.

## Observed in sandbox

1. **Correlation.** Without `custom_id`, events link only by PayPal IDs. Set `purchase_units[].custom_id` on orders and
   `custom_id` on subscriptions to our checkout ID. A capture links to its order through
   `resource.supplementary_data.related_ids.order_id`.
2. **Two payload generations.** `PAYMENT.SALE.COMPLETED` is the older shape: `amount.total`, lowercase
   `state: "completed"`, subscription in `billing_agreement_id`. Captures use `amount.value` and `status: "COMPLETED"`.
   The adapter normalizes both.
3. **Amount strings vary.** `"1.0"` in subscription `billing_info`, `"1.00"` elsewhere. Parse to integer minor units and
   never compare strings.
4. **Events arrive out of order.** `ACTIVATED` was received before `SALE.COMPLETED`, although the sale was created first.
   Grants can't depend on event order.
5. **One payment, several signals.** Approval, capture event and capture API response describe one payment. Dedupe events
   by event ID, and effects by capture or sale ID.
6. **Capture safety.** Capture without approval returns `422 ORDER_NOT_APPROVED`. A repeat with the same request ID returns
   the same capture. A repeat with a new request ID returns `422 ORDER_ALREADY_CAPTURED`.
7. **Renewals run in sandbox.** There's no clock skip, but a daily plan really renews: 7 cycles completed in 7 days. A
   monthly plan and a captured renewal webhook are still unverified.
8. **Renewals post after the scheduled time.** With `next_billing_time` at 10:00 UTC on 4 Nov, no payment had posted by 11:41 UTC.
   The previous payment posted at 11:32 UTC on 3 Nov. See the grace-period decision in `billing-rules.md`.
9. **Concurrent captures with one request ID are safe.** 20 at once on an approved order all succeeded with one capture, in two runs. No `409` for a request in flight appeared.
10. **Capture events carry the link.** A real `PAYMENT.CAPTURE.COMPLETED` has `resource.custom_id` (our checkout ID) as well as the order ID in `related_ids`.

## Sandbox setup

- Approve payments with a **US personal** sandbox account. The default personal account failed with "This seller doesn't accept
  payments in your currency", and a US one worked. The likely cause is an India-registered default account (not confirmed).
- Local webhooks need a public HTTPS tunnel (ngrok). A static domain avoids re-registering the webhook after each restart. Its address goes
  in `PUBLIC_BASE_URL`.
