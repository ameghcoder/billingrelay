import { sql, type SQL } from "drizzle-orm";

/** 5s, 30s, 2m, 10m, then every hour, by how many attempts have been made. */
export const retryDelay = (attempts: SQL) => sql`make_interval(secs => (ARRAY[5, 30, 120, 600, 3600])[LEAST(${attempts}, 5)])`;
