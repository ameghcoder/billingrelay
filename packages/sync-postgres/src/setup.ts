// Run once by the destination's owner: `pnpm destination:setup`. The worker never creates or drops anything.
// DESTINATION_OWNER_URL is needed only here; never give it to the worker.
// DESTINATION_SYNC_PASSWORD, if set, lets `billingrelay_sync` log in with it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { SCHEMA_VERSION } from "./destination";
import { destinationUrlProblem } from "./tls";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const migrations = readdirSync(migrationsFolder)
  .filter((name) => /^\d{3}_.+\.sql$/.test(name))
  .sort()
  .map((name) => ({ name, version: Number(name.slice(0, 3)) }));
if (migrations.at(-1)?.version !== SCHEMA_VERSION) fail("The migrations folder doesn't match SCHEMA_VERSION");

const ownerUrl = process.env.DESTINATION_OWNER_URL;
if (!ownerUrl) fail("DESTINATION_OWNER_URL is not set");
const urlProblem = destinationUrlProblem(ownerUrl);
if (urlProblem) fail(`DESTINATION_OWNER_URL refused: ${urlProblem}`);

const client = new pg.Client({ connectionString: ownerUrl, connectionTimeoutMillis: 5_000 });
try {
  await client.connect();

  const { rows } = await client.query<{ schema_exists: boolean; ours: boolean }>(`
    SELECT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'billingrelay') AS schema_exists,
           to_regclass('billingrelay.schema_version') IS NOT NULL AS ours`);
  const { schema_exists: schemaExists, ours } = rows[0]!;
  // Someone else's schema with our name: changing it could break their app, so stop before touching anything.
  if (schemaExists && !ours) fail("A schema named billingrelay already exists and BillingRelay didn't create it. Nothing was changed.");

  const current = ours ? ((await client.query<{ version: number }>("SELECT max(version) AS version FROM billingrelay.schema_version")).rows[0]?.version ?? 0) : 0;
  if (current > SCHEMA_VERSION) fail(`The destination is at version ${current}, newer than this code (${SCHEMA_VERSION}). Nothing was changed.`);

  // Each file is its own transaction, so a failure leaves the last complete version.
  for (const migration of migrations.filter((m) => m.version > current)) {
    await client.query(readFileSync(join(migrationsFolder, migration.name), "utf8"));
    console.log(`Applied ${migration.name}`);
  }

  const password = process.env.DESTINATION_SYNC_PASSWORD;
  if (password) {
    await client.query(`ALTER ROLE billingrelay_sync LOGIN PASSWORD ${client.escapeLiteral(password)}`);
    console.log("billingrelay_sync can log in");
  }
  console.log(`Destination ready at version ${SCHEMA_VERSION}`);
} catch (error) {
  // The server's message helps the owner fix it and never contains the password.
  fail(`Destination setup failed: ${error instanceof pg.DatabaseError ? `${error.code} ${error.message}` : error instanceof Error ? error.name : "unknown"}`);
} finally {
  await client.end().catch(() => {});
}
