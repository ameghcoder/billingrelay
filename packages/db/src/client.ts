import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const POOL_SETTINGS = {
  max: 5,
  connectionTimeoutMillis: 3_000,
  query_timeout: 5_000,
} satisfies pg.PoolConfig;

// On globalThis so Next's dev reloads don't leak a new pool each time.
const pools = ((globalThis as { __billingRelayPools?: Map<string, pg.Pool> }).__billingRelayPools ??=
  new Map<string, pg.Pool>());

function getPool(name: string, connectionString: string): pg.Pool {
  let pool = pools.get(name);
  if (!pool) {
    pool = new pg.Pool({ ...POOL_SETTINGS, connectionString });
    // Without a listener, an idle connection dropping (e.g. a DB restart) crashes the process.
    pool.on("error", (err) => console.error(`${name} pool error: ${err.message}`));
    pools.set(name, pool);
  }
  return pool;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function getSourcePool(): pg.Pool {
  return getPool("source", requireEnv("DATABASE_URL"));
}

export function getDb() {
  return drizzle(getSourcePool(), { schema });
}

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}
