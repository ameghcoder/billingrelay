# For judges

BillingRelay runs on Render against PayPal **sandbox**. No real money moves. The login details for the dashboard and a PayPal sandbox
buyer are in the submission form, never in this repo.

| What | Where |
|---|---|
| BillingRelay dashboard | `https://billingrelay-web.onrender.com/login` |
| Example shop (a merchant's app) | `https://billingrelay-example-shop.onrender.com` |
| Video (under 3 minutes) | linked from the submission |
| Tested commit | the release tag named in the submission |

## Five minutes, end to end

1. **Buy as a customer.** Open the example shop, sign in with any user name (the shop's own stand-in login), click **Buy pro** and pay
   with the sandbox buyer account. PayPal sends you back to the shop, which asks BillingRelay whether the money really arrived; it never
   trusts the redirect. Its home page then lists `pro` access, read only from the shop's own database, which BillingRelay's worker
   filled.
2. **See it as the merchant.** Sign in to the dashboard. **Billing → Checkouts** shows the purchase as `captured`; the **Sync** tab
   shows it delivered to the merchant's database. Click a customer to see the trace: payment, PayPal's events, effects, and each delivery
   attempt.
3. **Let the AI draft a setup.** **AI setup**: describe what you'd sell in a sentence (for example, "a $9 monthly plan with 100 credits,
   and a $5 pack of 50 credits"). It drafts a catalog that you review; **Flow** draws it. Nothing goes live until a person approves that
   exact version and then makes it live. Please don't make your own drafts live, so the shop keeps working for the next judge.
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

Sandbox only. One operator account, shared by judges. PayPal's sandbox can be slow, so a purchase may take up to a minute to show as
delivered. If the shop says the purchase is still on its way, refresh. Not supported: providers other than PayPal, tax, trials,
proration, automatic refunds.
