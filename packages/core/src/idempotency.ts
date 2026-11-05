import { createHash } from "node:crypto";
import { z } from "zod";

export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{1,255}$/);

/** Sorted keys, so a request hashes the same however its JSON was written. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash the parsed request, not the raw body, so a left-out default counts the same as sending it. */
export const hashPayload = (payload: unknown) => createHash("sha256").update(canonicalJson(payload)).digest("hex");
