# Submission

**Story:** describe what you sell, review one billing configuration, accept payment, and see correct records in your own application database. Show
the whole product, not the number of integrations.

## Evidence per judging criterion

The five criteria have equal weight; implementation is first in tie-breaking. This is an evidence plan, not a prediction of scores.

| Criterion | Proposed evidence |
|---|---|
| Implementation | Real PayPal flows, verified observations, recurring and credit rules, independent delivery, useful AI tools |
| Design | Clear setup, reviewed schema, understandable statuses, small SDK, helpful next actions |
| Impact | Specific developer problem, independent install, actual setup observations, genuine feedback |
| Innovation | Explain the combination and acknowledge existing tools; show the workflow advantage |
| Presentation | Coherent end-to-end functionality; test data and faults labelled honestly |

## Video (under 3 minutes)

Recorded on the local stack (README, or `docs/self-host.md`) with the ngrok tunnel, plus one cut for Supabase. Before recording: the
shop's `pro` product is live, `psql` reaches the merchant database (`docker compose exec destination-db psql -U merchant -d merchant`),
and a browser tab is open on each screen below.
Every scene is real; the one fault is made on camera and said so.

| Time | Screen | Click / type | Say |
|---|---|---|---|
| 0:00–0:15 | Example shop | Sign in as `maya` | "Taking a PayPal payment is easy. Knowing it really happened, granting it once, and getting it into your own database is the work. BillingRelay does that part." |
| 0:15–0:45 | **AI setup** | Type "Keep pro as it is. Add a 9 USD monthly plan with 100 credits a month, and a 5 USD pack of 50 credits" (currency in the same message, or it stops to ask); check the diff removes nothing, **Draft a catalog**, then **Save as a new version**; open **Flow** | "I describe what I sell. The AI drafts the catalog and checks it against every rule; the flow shows what each purchase grants. It can't approve or go live." |
| 0:45–0:55 | **Catalog** | On the new version: **Approve vN**, then **Make vN live** | "A person approves this exact version. Change anything and the approval is gone." |
| 0:55–1:25 | Shop → PayPal | **Buy pro**, sign in as the sandbox buyer, pay | "A real PayPal sandbox checkout." |
| 1:25–1:45 | Shop return, then home | Wait for `captured`; home lists `pro` | "The shop doesn't trust the redirect: it asks BillingRelay, which asked PayPal. And this access comes from the shop's own database." |
| 1:45–2:00 | **Billing** | **Checkouts**, then the **Sync** tab | "Money, what was granted, and delivery are tracked separately. Every PayPal event is verified and stored before it's acknowledged." |
| 2:00–2:35 | Terminal, then customer page | `psql`: `REVOKE INSERT, UPDATE ON billingrelay.customers, billingrelay.purchases, billingrelay.access FROM billingrelay_sync;` Buy again as `maya2`. On `maya2`'s page: **Investigate**, "She paid but my database doesn't show it. Why?" | "Now I break the merchant's database on purpose. The payment still lands, but the copy is refused. The AI reads the evidence and names the cause." |
| 2:35–2:45 | Same page, terminal | `GRANT SELECT, INSERT, UPDATE ON … TO billingrelay_sync;` then **Approve**, **Run** | "It can only propose a safe, existing action: retry the delivery. A person approves; it runs once." Show the row arrived |
| 2:45–2:58 | README, local Supabase cut | Show the SDK call, `docs/self-host.md`, Supabase's table editor with the `billingrelay` schema | "A typed SDK, an MCP adapter, Docker self-host, and any Postgres, including Supabase. Open source, PayPal only, sandbox." |

Supply reproducible evidence for flows that don't fit the video (`docs/verification.md`, the capability matrix). No fake metrics.

## Checklist

- [x] Open-source license (`LICENSE`, MIT)
- [x] Reproducible instructions: README (local), `docs/self-host.md` (Docker), `docs/deploy-render.md` (hosted)
- [x] Accurate capability matrix (README) and the proof map (`docs/verification.md`)
- [x] Explanation of AI usage: `docs/ai-agents.md`, the README's "Why"
- [x] Postman collection with no secrets (`docs/postman/`)
- [ ] Repo public, judged commit tagged
- [x] Full local setup instead of a hosted demo: `docs/self-host.md`, verified from a clean folder to a real purchase (Render needs a
      card, so the Blueprint stays documented but undeployed)
- [ ] Public YouTube video under three minutes, linked in `docs/judges.md` and the form

Keep secrets out of the repo, video and collections. Freeze the judged release at the deadline and avoid substantive later changes.

## Sponsor tools

| Sponsor | Decision and purpose |
|---|---|
| AG Grid Community | Core data tables; the MIT license fits the self-hostable base |
| AG Studio | Optional analytics page. Commercially licensed, so keep it optional and disabled without a valid license. Confirm trial coverage through judging; the project's open-source license grants no commercial dependency rights |
| APIMatic | PayPal Context Plugin with Claude Code; document actual use. Development help, not user-facing AI |
| Postman | Publish API scenarios and a safe environment template. No secrets in shared collections |
| Render | Hosted web + persistent worker. Advertised building credits; check actual service cost and availability through judging |
