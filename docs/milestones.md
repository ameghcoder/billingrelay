# Milestones

Each milestone has a build scope and a pass check. M08 and M10 aren't used. M18 and M19 come directly after M12.

For each step, record the commit, actual hours, pass-check result, one proof artifact, unresolved issues and next action. A social post is
optional and only follows a passed check.

**M00 Contracts and test access.** Write API, authority and capability rules. Test PayPal credentials and recurring access. Ask 2–3 developers about their
integration pain. *Pass:* PayPal responds; subscription blockers are recorded; no unverified capability is marked done.

**M01 Scaffold and operator login.** Monorepo, web/API, persistent worker, migrations, operator login, env examples, two Postgres instances. *Pass:* a clean
checkout boots the stack; admin routes need a valid session.

**M02 Connect PayPal.** Connection form, protected secrets, test/live separation, webhook config, health and capability checks. *Pass:* secrets never appear in
browser output, logs or ordinary readback.

**M03 Catalog and basic schema.** Products, variants, limited custom fields, configured prices, benefit rules, schema versions. *Pass:* two license variants validate;
bad fields fail; stored config can be inspected.

**M04 Trusted backend quotes.** Authenticated quote creation, customer binding, expiry, amount/currency checks, immutable snapshots. *Pass:* browser tampering and expired
quotes fail; retrying the same operation reuses its result.

**M05 First real PayPal purchase.** Platform checkout, create/approve/capture, server checks, status, real event verification. *Pass:* a real sandbox payment maps to the right
customer and snapshot; uncertainty doesn't trigger a second charge.

**M06 Durable processing.** Verified inbox, worker, semantic dedupe, separate states, source effects, transactional outbox. *Pass:* callback plus repeated webhook yields one
effect; a restart preserves pending work.

**M07 Independent database sync.** Restricted target schema, migration, versioned delivery, retry history, lag. *Pass:* stop target, complete a purchase, reconnect: it converges
with no second payment or duplicate row, and old versions can't overwrite new ones.

**M09 PayPal recurring plan.** One monthly plan, paid access, renewal evidence, cancellation, paid-through policy. Includes the monthly plan and cancellation checks left over from
M00, and capturing a real renewal webhook. *Pass:* a real sandbox subscription works; repeated observations don't duplicate paid benefits; renewal testing is documented.

**M11 Credit packs and usage.** Purchase grants, atomic debit, stable usage identity, compensation, balance projection, and `GET /v1/customers/:externalCustomerId/billing`
for access and balance. *Pass:* no duplicate grant or debit, no overspend; one failed
usage gets one compensation.

**M12 Reviewed AI configuration.** Plain-language input, small tools, validated draft, capability checks, missing-decision prompts, approval. *Pass:* membership, pack and variant
generate a valid reviewable draft; nothing activates without approval.

**M18 Visual flow builder.** Generated, inspectable flow with limited setting edits and execution status, editing the same draft as chat. *Pass:* a flow generated from a real draft
shows each node's settings, and an edit there appears in the same draft version history and invalidates approval.

**M19 MCP adapter.** Thin adapter over the same tools, with the same permissions, approvals and audit trail. *Pass:* an external MCP client can draft and inspect, but can't activate
anything without approval.

**M13 Billing and sync dashboard.** AG Grid tables, status filters, project/customer trace, separate currency totals. *Pass:* find paid-but-unsynced records quickly and drill into an
actual attempt.

**M14 Reconciliation and investigation.** Unresolved-record scans, PayPal re-read, delivery retry, scoped AI evidence, reviewed proposals. *Pass:* a target failure suggests the existing
retry; a fulfilled or mismatched purchase gets no new credit action.

**M15 Cross-flow failure tests.** Invariant tests, PayPal fixtures, source and target failures, auth, stale events, refund review, amount mismatch. *Pass:* critical tests pass on real
Postgres; an actual checkout has run; unknowns are documented.

**M16 SDK and self-host install.** Thin SDK, independent app, Docker setup, migrations, target-role setup, troubleshooting. *Pass:* a fresh environment or another developer follows setup
without hidden machine state.

**M17 Package and submit.** Hosted judge path, README and license, capability matrix, public video, screenshots, release. *Pass:* access and links work; no secrets; the demonstrated commit
matches the release; required services stay usable through judging.
