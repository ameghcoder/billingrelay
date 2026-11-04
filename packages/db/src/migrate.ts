import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closePools, getDb } from "./client";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

await migrate(getDb(), { migrationsFolder });
await closePools();
console.log("Source database migrated");
