# BillingRelay

Open-source billing layer between PayPal and your app. Describe what you sell, approve the
config, take payments through PayPal, and read correct billing state from your own Postgres.

> Sandbox prototype for the PayPal AI Hackathon. No live money. Working name only.

## Capability matrix

Only capabilities with a recorded proof are marked verified.

| Capability | Status | Proof |
|---|---|---|
| PayPal sandbox OAuth | ✅ verified with a script | Token returned |
| One-time order: create, approve, capture | ✅ verified with a script | Order `0C768617WF029362W`, capture `37L31305X26514342` |
| Duplicate capture is safe | ✅ verified with a script | Same result on the same request ID; `ORDER_ALREADY_CAPTURED` on a new one |
| Webhook signature verification | ✅ verified with a script | 4 real events, all `verification=SUCCESS` |
| Monthly fixed subscription plan | ⬜ not verified | |
| Subscription renewal observed | ✅ daily plan only | Subscription `I-937ASKVASBHS`, 7 cycles completed; renewal webhook not captured yet |
| BillingRelay checkout, inbox and ledger | ⬜ not built | |
| Credit packs and atomic consumption | ⬜ not built | |
| One-way sync to an independent Postgres | ⬜ not built | |
| AI billing setup (reviewed draft) | ⬜ not built | |
| AI investigation and safe retry | ⬜ not built | |

Not supported: providers other than PayPal, tax, inventory, shipping, trials, proration,
mid-cycle upgrades, automatic refunds, currency conversion.
