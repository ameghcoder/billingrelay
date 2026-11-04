# CLAUDE.md

## Project

BillingRelay: an open-source billing layer between PayPal and a developer's existing app. The
developer describes what they sell; BillingRelay sets up checkout, verifies payments, keeps the
authoritative billing ledger (subscriptions, credit packs, one-time purchases) and optionally syncs
that state one-way into the developer's own Postgres. AI drafts billing setup and investigates
failures; every change it proposes needs approval. Built for the PayPal AI Hackathon.
**Sandbox only: no real customer data or live money.**

**PayPal is the only payment provider.**

Stack: Next.js App Router + TypeScript, Tailwind + Shadcn, AG Grid Community, React Hook Form + Zod,
Better Auth, Postgres (source + a separate destination; Supabase supported), Drizzle, pg-boss with a
persistent Node worker, AI SDK, Vitest + Playwright, pnpm workspace, Docker Compose, Render.

Layout: `apps/web` (dashboard, API routes, checkout, auth), `apps/worker` (processing, sync,
reconciliation), `packages/core` (billing/access/ledger invariants), `packages/providers/paypal`,
`packages/db` (schema, migrations, transactions), `packages/sync-postgres` (destination migration
and delivery), `packages/sdk` (thin server SDK), `examples/merchant-app`.

Docs: `context-map.md` indexes `docs/*.md` by topic; decisions (ADRs) in `docs/decisions/`;
flow diagrams in `docs/design-flow/`. Committed docs never reference files outside this repo.

## Working style

We work step by step through `docs/milestones.md`. Both the founder and Claude write code.

- **Done = the milestone's pass check passes locally against PayPal sandbox**, with proof saved.
  Deploy to Render at checkpoints: first after M07 (sync), then before the freeze.
- **Flow first.** Before starting each task, Claude writes a rough, understandable flow diagram to
  `.temp/flows/<milestone>-<slug>.md` and stops. Code starts only after the founder has reviewed it.
  A diagram moves to `docs/design-flow/` only when its flow is really finished and worth keeping.
- **Ownership.** Claude writes code including the money paths: PayPal handlers, webhook verification,
  ledger/credit transactions, inbox/outbox processing and the destination upsert. The founder
  line-reviews money-path code before it's committed. The founder may write any part.
- **Review the founder's code like a senior engineer**: correctness first, then architecture,
  then idiom. Be direct and explain why.
- **Guard scope.** The full scope in `docs/milestones.md` stays; features are cut only by the founder.
  A follow-up found mid-task goes to the index as one line, unless it blocks the current milestone.
  Propose; the founder decides. The demo path comes first: AI draft → flow → approve → sandbox
  checkout → destination DB row → deliberate sync failure → investigation → retry.
- **Never start the next task without asking**, even when the index names it next.
- **Keep `main` working.** Unfinished work stays behind a flag or off `main`.
- **Flows:** read a flow's diagram in `docs/design-flow/` before its code. A change that adds,
  removes or reorders a step updates the diagram in the same task.
- **Discussion stays discussion.** When the founder says "discuss" or "just tell me", answer.
  Don't edit files, and don't force a choice with a question prompt.

## Billing invariants (never break)

- Verify a PayPal webhook and store it in the inbox before acknowledging it.
- A billing change and its outbox row commit in one source transaction.
- One eligible payment produces each configured effect at most once; one usage ID debits once.
- The destination copy only accepts a newer `source_version`. Sync copies balances; it never adds credits.
- Money, fulfillment and sync status stay separate. A retry never creates another charge; a
  timeout never authorizes a replacement charge.
- Prices come from stored config or a server quote, never the browser. Customer identity comes
  from the merchant's authenticated session, keyed on `(project_id, external_customer_id)`, not email.
- AI cannot mark payments successful, edit balances, run SQL or issue refunds. Approval binds to
  an exact config version; any change invalidates it.

## Checks scale with risk

- **High** (payments, webhooks, ledger, sync, migrations, auth, secrets): the full sandbox check below.
- **Medium** (new API behaviour, AI tools): tests plus targeted runs.
- **Low** (UI, copy, small fixes): tests plus a quick look.

**Verify at the entry point:** test through the real route or UI a user hits, not by calling an
inner function with hand-picked options. Invariant tests run against real Postgres, not mocks.

**Sandbox check:** `.temp/checks/<NUM>-<slug>/` with `README.md` (scenarios and expected outcome),
`config/` (fixtures, env overrides, scripts) and `result/verdict.md` (pass/fail per scenario,
what was fixed). Cover, where they apply:
- good / neutral / bad paths: duplicate and out-of-order webhooks, invalid signatures, wrong amount,
  PayPal or the destination DB down, timeouts and retries;
- a crash mid-way (kill the worker while it runs), then the retry;
- real payload shapes: captured PayPal sandbox payloads, not invented ones. Simulator events are
  labelled as mocks and never count as proof of a real capture;
- at Render checkpoints: build each touched app the way Render builds it, with production settings
  and only that service's env vars. A dev build can pass while the real deploy fails.

Checks run locally against PayPal sandbox and local Docker Postgres, never against the hosted demo.

## Tasks and issues

One GitHub issue per milestone, opened right before the milestone starts, never ahead of time.
Issue numbers can't be reserved, and guessed numbers drift onto unrelated issues.

- `.temp/tasks/index.md` tracks milestones and sub-steps. A milestone with no issue yet is listed
  by its ID (`M05`). When it starts, open the issue and add `#NUM` next to it. Sub-steps sit under
  their milestone and use the milestone's `#NUM`.
- Index entries are ordered-list items, 2–3 lines each: `#NUM ⬜ summary` (⬜ todo, 🔧 in progress,
  ✅ done). New items go under `## <theme> (YYYY-MM-DD)` with today's date. Never append undated
  items to an older section.
- Per milestone, record: commit, actual hours, pass-check result, one proof artifact, open issues,
  next action. A longer write-up goes in `.temp/tasks/issue_NUM.md`, linked from the index.
- **Close an issue only on the founder's explicit go**, after its pass check. The closing comment
  carries the verdict.
- Account setup (PayPal sandbox apps, Render, sponsor tools) goes in `.temp/tasks/external.md`.
- `.temp/` is gitignored and temporary. Throwaway scripts go there, never in a committed folder.

## Commits

- Format: `#NUM type: summary`, number first, under 72 characters. Add at most 1–2 short body lines.
- **Never put a closing keyword before an issue number** (`fixes #12`, `closes #12`): GitHub
  closes the issue on push, before anyone has checked it.
- Claude may commit its own work once its checks pass, and once the founder has line-reviewed any
  money-path code. Never commit the founder's uncommitted work without asking. Stage paths explicitly, never `git add -A` or `git add .`.
- **Never run `git push`.** The founder pushes.
- Never commit `.env*`, `.claude/` or `.temp/`.

## Safety

- Never print or log secrets. Read env vars without echoing them:
  `source <(grep '^VAR=' .env.local)`. Secrets stay out of browser code, logs, AI evidence,
  Postman collections and the demo video.
- Claude may apply migrations to local Docker databases only. Never to Render or any hosted
  database; the founder applies those. After the first Render deploy, migrations only add.
- Don't touch the founder's dev servers or local data, and never run a broad `pkill`. Kill every
  process you start before ending a turn.
- Don't build in the main tree while a dev server uses its build folder; use a separate worktree.
- Before deleting or overwriting anything, look at it first.

## Code conventions

- Use the Shadcn component when one exists, and AG Grid for data tables. Hand-roll only when
  neither fits, and say so.
- Database access lives in `packages/db`; apps and the worker don't import Drizzle directly.
  Critical money transactions use explicit, parameterized SQL.
- PayPal-specific code stays in `packages/providers/paypal`. Don't build a multi-provider
  abstraction.
- API request/response shapes are Zod schemas defined once. The routes, SDK, AI tools and MCP all
  import those schemas. Keep the README capability matrix in step with what has actually been verified.
- Comments stay short: one or two lines, giving only the non-obvious reason.
- Match the surrounding code's naming and idiom.

## Talking to the founder

Be concise and use plain words. Recommend one option instead of listing them all. Report results
honestly: say when tests fail and include the output, and name any step that was skipped.
