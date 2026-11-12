# For judges

BillingRelay runs on your machine with Docker, against PayPal **sandbox**. No real money moves. The video shows the whole flow; this
page is how to run it yourself.

| What | Where |
|---|---|
| Video (under 3 minutes) | linked from the submission |
| Run it: Docker, about 5 minutes to build | [`docs/self-host.md`](self-host.md) |
| Tested commit | the release tag named in the submission |

You need Docker, a PayPal sandbox app (client ID and secret from developer.paypal.com, free), a sandbox **personal** account to pay
with (created in the same dashboard), and a public https tunnel such as ngrok, so PayPal can reach your machine. `docs/self-host.md`
starts BillingRelay at `http://localhost:3100` and the example shop at `http://localhost:3200`. Its steps 1–7 are the setup below.
Hosting on Render is described in `docs/deploy-render.md`.

## Five minutes, end to end

1. **Buy as a customer.** Open the example shop (`http://localhost:3200`), sign in with any user name (the shop's own stand-in login), click **Buy pro** and pay
   with the sandbox buyer account. PayPal sends you back to the shop, which asks BillingRelay whether the money really arrived; it never
   trusts the redirect. Its home page then lists `pro` access, read only from the shop's own database, which BillingRelay's worker
   filled.
2. **See it as the merchant.** Sign in to the dashboard. **Billing → Checkouts** shows the purchase as `captured`; the **Sync** tab
   shows it delivered to the merchant's database. Click a customer to see the trace: payment, PayPal's events, effects, and each delivery
   attempt.
3. **Let the AI draft a setup.** **AI setup**: describe what you'd sell in a sentence (for example, "Keep pro as it is. Add a 9 USD monthly
   plan with 100 credits a month, and a 5 USD pack of 50 credits"). It drafts a catalog that you review; **Flow** draws it. Nothing goes live until a person approves that
   exact version and then makes it live. If a draft drops `pro`, the shop's
   **Buy pro** button stops working until `pro` is live again.
4. **Ask the AI about a customer.** On a customer's page, **Investigate** with a question like "Did this customer get what they paid for?".
   It reads the records and answers with evidence. It can only propose an existing safe action, such as retrying a delivery, which a
   person approves; it can't mark payments, change balances or refund.
5. **Use the API.** **Developers** → create a backend key (shown once), then follow the `curl` examples in the README, or the Postman
   collection in `docs/postman/`.

## What to look for

- **Money first:** every payment is confirmed by asking PayPal, never from the browser or a webhook's own amounts. A retry or a timeout
  never charges twice.
- **Exactly once:** replayed or out-of-order PayPal events can't grant anything twice; one usage ID debits credits once.
- **Your own database:** sync is one-way and only moves forward; a database that was down catches up by itself.
- **AI with a leash:** drafts and investigations, all approved by a person, all audited.

The capability matrix in the README says which of these were proven, and how. `docs/verification.md` maps each guarantee to its test.

## Limits

Sandbox only. One operator account per install. PayPal's sandbox can be slow, so a purchase may take up to a minute to show as
delivered. If the shop says the purchase is still on its way, refresh. Not supported: providers other than PayPal, tax, trials,
proration, automatic refunds.
