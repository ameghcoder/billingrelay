# AI agents and visual billing flows

Two AI roles: configure billing before launch, then investigate billing problems after launch.

**Boundary:** AI helps set up and operate a project's billing. It doesn't build the customer's application. PayPal processes payments;
BillingRelay verifies events, maintains billing records and optionally syncs the app's database.

## Primary: billing setup agent

A developer describes their business model. The agent turns it into a structured proposal, shows the flow, and applies approved, supported
configuration.

> "Create a $19 monthly plan with 2,000 credits and a $5 pack for 1,000 extra credits. Use my existing user IDs and synchronize to my Postgres
> database."

1. **Clarify the rules.** Ask about credit expiry or carryover, renewal grants, cancellation access and refund handling. Don't silently invent
   business policies.
2. **Draft the billing project.** Products, fixed plans, credit rules, customer-ID mapping, API-only or Postgres sync. The result is a versioned draft.
3. **Show the generated flow.** Checkout, verified payment, billing effects, optional database delivery. Developers inspect each node and edit
   supported settings.
4. **Validate and preview.** Check against supported capabilities, and preview effects and delivery with fixtures. Label simulations clearly; they
   don't prove the PayPal integration works.
5. **Approve, apply and test.** Review prices, rules and resource changes. After approval, backend tools apply PayPal resources and BillingRelay
   config. Run an actual sandbox checkout to confirm the resulting state.

AI must not invent credentials, guess taxes, silently change prices or claim an unverified capability.

### As built (M12)

- `/admin/ai`: the operator describes what they sell. `packages/ai` runs the model (gpt-4o-mini by default, `OPENAI_MODEL` to change) with three
  tools: read the live catalog, check a proposal against every catalog and activation rule, and ask the operator. At most 6 steps; asking ends the turn.
- **Enforced in code, not the prompt:** every price and credit amount in a new or changed product must be a number the person wrote in this
  conversation (or one that product already had live). A price copied from another product is refused back to the model, which then asks.
- The proposal is shown against what's live (new, changed, removed). Saving it makes an ordinary new version, not approved and not live.
- **Approval** binds to one version and the hash of its stored config. Going live checks both inside the activation transaction.
- Every AI run, approval and activation is in `audit_event`, with IDs and hashes, never the prompt's text.
- No key, or the model down: the route says so and the catalog editor works as before.

## Supporting: billing investigation agent

> "The customer paid, but Pro access is still missing."

1. **Inspect the trace.** Verified payment facts, subscription/access state, credit ledger, sync attempts. Separate payment status from delivery status.
2. **Explain the cause.** Output separates observed facts, evidence IDs, inference, uncertainty and a supported proposal. If evidence is incomplete,
   report uncertainty.
3. **Propose a specific repair.** A retry of an eligible sync delivery, or replay through existing deterministic, duplicate-safe handlers. Show the
   affected customer and operation.
4. **Execute an approved repair.** The backend rechecks eligibility and permissions, records the action, retries, and reports the actual result. Never
   charge the customer again to fix a delivery failure.

Example: the capture completed, the billing transaction committed, the target connection failed. Retry this existing outbox delivery; don't charge again.

## Dashboard, flow builder and MCP share one backend

| Surface | Purpose and first-version boundary |
|---|---|
| Dashboard AI | Describe monetization, review the proposal, test and approve config |
| Visual flow builder | A generated, inspectable flow with limited setting edits. Shows execution status and errors. Arbitrary connections, loops and custom code are deferred |
| MCP interface | External AI clients use the same scoped tools. Starts as a thin endpoint/package; separate deployment is optional |

Canvas and chat edit the same validated draft. MCP uses the same permissions, approval records and audit trail. A draft can't become active just because an
AI client asks.

## Guardrails

| Allowed | Enforced outside the model |
|---|---|
| Read scoped records | Project scope and PayPal connection are injected by the server |
| Draft supported configuration | Schema and capability validation; developer review |
| Propose a known delivery or processing retry | Permissions, fresh state, expected version and approval |
| Explain a completed or mismatched record | No unnecessary credit or payment action |

- **Shared tool layer:** reuse the TypeScript backend, Postgres and worker; add a tool-capable model, Zod/JSON Schema contracts and a thin MCP adapter. Suggested
  tools: draft configuration, validate configuration, inspect transaction, request retry.
- **Approval lives in the backend:** bound to project, environment and exact config version. Changes invalidate it. Credentials are scoped to projects, secrets
  stay server-side, and all actions are audited.
- **Deterministic execution:** backend code owns prices, balances, payment verification and permissions. AI can't mark payments successful, edit balances, run
  arbitrary SQL or shell commands, call arbitrary URLs or issue refunds. Logs, tool output, customer metadata and merchant notes are untrusted data, not instructions.
- **Failure handling:** validate drafts before writes. Track partial PayPal setup and resume idempotently; a local transaction can't roll back PayPal resources. Manual
  setup and normal billing keep working if the model is unavailable. Limit tool rounds, duration and inference spend. Redact credentials and unnecessary personal data.

## Optional: agent payment acceptance

Only after everything else works reliably. A merchant's agent requests payment for a task through the same API or MCP tools.

Research agent offers a $2 report → creates a task-bound checkout link → customer pays through PayPal → BillingRelay verifies payment → agent checks paid status
and delivers.

Each request binds to project, task, customer, amount, currency and expiry, with duplicate-safe creation and a server-side payment check before delivery. This is
payment acceptance on the merchant's behalf. Autonomous spending and agent-to-agent settlement remain future work.
