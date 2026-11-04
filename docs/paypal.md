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

## Sandbox setup

- Approve payments with a **US personal** sandbox account. The default personal account failed with "This seller doesn't accept
  payments in your currency", and a US one worked. The likely cause is an India-registered default account (not confirmed).
- Local webhooks need a public HTTPS tunnel (ngrok). A static domain avoids re-registering the webhook after each restart.
- The webhook ID goes in `PAYPAL_WEBHOOK_ID`. It's the ID PayPal shows after saving, not the URL.
