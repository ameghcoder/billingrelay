# Self-host with Docker

BillingRelay on one machine with `docker compose`: its own Postgres, the web app, the worker, and the example merchant app with the
database it owns. The images are built the way Render builds them (`render.yaml`), from the one `Dockerfile`. Sandbox only.

You need Docker with Compose v2, a PayPal sandbox app (client ID and secret, from developer.paypal.com), and a public https address that
reaches your machine, such as an ngrok tunnel. PayPal sends webhooks there, and the buyer lands there to pay.

## Steps

1. **Settings.** In the repo folder:
   ```sh
   cp .env.selfhost.example .env.selfhost
   ```
   Fill in every empty value: passwords with `openssl rand -hex 24`, and `BETTER_AUTH_SECRET` and `SECRETS_ENCRYPTION_KEY` with
   `openssl rand -base64 32`. `PUBLIC_BASE_URL` is your tunnel's
   https address, pointing at `localhost:3100` (for ngrok: `ngrok http 3100`). `.env.selfhost` is gitignored; keep it out of commits.
2. **Start it:**
   ```sh
   docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d --build
   ```
   The first build takes a few minutes. `setup` runs once and exits: it migrates BillingRelay's database, creates the operator from
   `OPERATOR_EMAIL` and `OPERATOR_PASSWORD`, and creates the `billingrelay` schema and the worker's restricted role in the merchant
   database. Each step is safe to run again. `docker compose … logs setup` should end with `Destination ready at version 3`.
3. **Check:** `curl localhost:3100/api/health` returns 200 with `{"source":"ok","destination":"ok","worker":"ok"}`.
4. **Connect PayPal:** open `http://localhost:3100/login`, sign in as the operator, open **PayPal** and enter the sandbox app's client ID
   and secret. This registers the webhook at `PUBLIC_BASE_URL`.
5. **Sell something:** in **Catalog**, add a one-time product with ref `pro` and a price (or use **AI setup**), save it, then **Approve** and **Make … live**.
6. **Connect the example app:** in **Developers**, create a backend API key and add `http://localhost:3200` under **Allowed return URLs**. Put the key in
   `.env.selfhost` as `BILLINGRELAY_API_KEY`, then:
   ```sh
   docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost up -d merchant-app
   ```
7. **Buy it:** open `http://localhost:3200`, sign in as any user ID, click **Buy pro** and pay with a PayPal sandbox **personal** account.
   Back in the example app, the return page shows money `captured`, then the purchase arrives in its own database. The home page lists the
   access, read only from `billingrelay.access` in that database.

To stop: `docker compose -f docker-compose.selfhost.yml down`. Add `-v` to delete both databases as well.

## Your own database instead of the bundled one

Point the worker at any Postgres you own. Run setup once as that database's owner, with `DESTINATION_OWNER_URL` and
`DESTINATION_SYNC_PASSWORD` set (`pnpm destination:setup`, or the `setup` service with those changed). Then set the worker's
`DESTINATION_DATABASE_URL` to `postgres://billingrelay_sync:<password>@<host>/<db>?sslmode=verify-full`. A host on the public internet
always needs `verify-full`; only a one-word hostname or a private IP may skip TLS, and only with `DESTINATION_PRIVATE_NETWORK=1`. Supabase:
see `docs/deploy-render.md`.

## Troubleshooting

`/api/health` and the dashboard's **Sync** page show the destination's state; a `not_ready` state carries a code, and the worker log
(`docker compose … logs worker`) has a line naming it.

| What you see | Why | Fix |
|---|---|---|
| `setup` exits with `… is missing a value` | A required setting is empty | Fill it in `.env.selfhost` |
| `setup`: `A schema named billingrelay already exists and BillingRelay didn't create it` | The database already has a schema with that name | Use another database; nothing was changed |
| `not_ready (login_rejected)` | The worker's password doesn't match the role | Run setup again with the same `DESTINATION_SYNC_PASSWORD` the worker uses |
| `not_ready (permission_denied)` | The `billingrelay_sync` role lost its grants | Run setup again, or grant `SELECT, INSERT, UPDATE` on the `billingrelay` tables back to it |
| `not_ready (schema_version_mismatch)` | The destination is older than this code | Run setup again; it applies only the missing migrations |
| `not_ready (role_too_powerful)` | The worker logs in as an owner or superuser | Give the worker the `billingrelay_sync` role, never the owner |
| `not_ready (tls_required)`, `tls_unverified`, `tls_unavailable` | A public host without verified TLS | Use `sslmode=verify-full` with a host whose certificate verifies |
| `down (unreachable)` or `timeout` | The worker can't reach the database | Check the host, port and network; deliveries wait and resume by themselves |
| **PayPal** page says the webhook is `Not set up` | `PUBLIC_BASE_URL` isn't https or isn't reachable from the internet | Start the tunnel, set the address, restart `web`, and save the PayPal connection again |
| Payments complete but events never arrive | The tunnel's address changed | Update `PUBLIC_BASE_URL`, restart `web`, save the PayPal connection again. The worker still finds the order within minutes, without events |
| Sign-in or API calls get `429` from every client | All clients share one rate-limit count | Behind a proxy, set `CLIENT_IP_HEADER` to the header it sets to the client's IP (see `docs/deploy-render.md`) |
| Example app: `BillingRelay refused: invalid_api_key` | The key is missing, revoked or mistyped | Create a backend key, set `BILLINGRELAY_API_KEY`, run `up -d merchant-app` |
| Example app: `BillingRelay refused: return_url_not_allowed` | The app's address isn't an allowed return URL | Add `http://localhost:3200` under **Developers → Allowed return URLs** |
| Example app: purchase `captured` but not in its database | The worker isn't delivering | Check `/api/health` and the **Sync** page; retry from there once the cause is fixed |
