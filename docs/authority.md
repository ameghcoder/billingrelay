# Authority rules

Status: **proposed (M00)**. Who owns each fact, and who may change what.

## Source of truth

| Fact | Owner | Others hold |
|---|---|---|
| Order, capture, subscription, payment status | PayPal | BillingRelay stores verified observations and raw references |
| Billing config (products, prices, benefit rules) | BillingRelay (approved version) | PayPal holds mapped products/plans |
| Access decision, `paidThrough` | BillingRelay | Destination DB holds a read-only copy |
| Credit ledger and balance | BillingRelay | Destination DB holds a read-only balance copy |
| App users | Merchant app | BillingRelay maps `(project_id, external_customer_id)` |

A PayPal browser redirect is never a fact. Only a server-side read or a verified webhook is.

## Callers

| Caller | May | May not |
|---|---|---|
| Merchant backend (API key) | Create quotes and checkouts, read billing, consume or compensate credits, cancel subscriptions, all within its project and environment | Touch other projects, set prices on catalog checkouts, read secrets |
| End-user browser | Open the hosted checkout, see safe status | Call `/v1`, set an amount or customer ID |
| PayPal webhook | Deliver a signed event for its connection | Be trusted because it names an ID; it must verify |
| Operator (session) | Review and approve config, investigations and repairs; retry deliveries | Edit balances or payment status directly |
| AI agent / MCP client | Read scoped evidence, draft config, propose known repairs | Approve, mark payments successful, edit balances, run SQL, issue refunds, call arbitrary URLs |
| Sync worker | Upsert newer versions into `billingrelay.*` on the destination | Write outside its schema, add credits, delete user tables |

## Approval

An approval is bound to project, environment, the exact draft or action version, and the approver.
Any change to the draft invalidates it. The backend rechecks current state before executing. Every
approval and execution is written to the audit log with its actual outcome.
