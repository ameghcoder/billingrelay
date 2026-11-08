/**
 * `down` and `not_ready` are the destination's fault, so they never use up a row's attempts.
 * `refused` is this one row, which backs off on its own while others flow past.
 */
export type DestinationFailure = { kind: "down" | "not_ready" | "refused"; code: string };

// Node's own codes for a database we can't reach.
const UNREACHABLE = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "EPIPE"]);
// A certificate that can't be verified is a setup problem: retrying won't make it trusted.
const UNTRUSTED_CERTIFICATE = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const SQLSTATE = /^[0-9A-Z]{5}$/;

function fromSqlState(code: string): DestinationFailure {
  // Connection lost, shutting down, starting up, too many connections, or a server-side timeout.
  if (code.startsWith("08") || code.startsWith("57P") || code.startsWith("53") || code === "57014") return { kind: "down", code: `pg_${code}` };
  if (code.startsWith("28")) return { kind: "not_ready", code: "login_rejected" };
  if (code === "3D000") return { kind: "not_ready", code: "database_missing" };
  if (code === "42501") return { kind: "not_ready", code: "permission_denied" };
  if (code === "3F000" || code === "42P01" || code === "42703") return { kind: "not_ready", code: "schema_mismatch" };
  if (code === "25006") return { kind: "not_ready", code: "read_only" };
  return { kind: "refused", code: `pg_${code}` };
}

/** Only a code comes out, never the error's text: Postgres errors can quote row values, and connection errors the host. */
export function classifyDestinationError(error: unknown): DestinationFailure {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
  if (code && SQLSTATE.test(code)) return fromSqlState(code);
  if (code && UNREACHABLE.has(code)) return { kind: "down", code: "unreachable" };
  if (code && UNTRUSTED_CERTIFICATE.has(code)) return { kind: "not_ready", code: "tls_unverified" };

  // node-postgres reports these with no code.
  const message = error instanceof Error ? error.message : "";
  if (/does not support SSL/i.test(message)) return { kind: "not_ready", code: "tls_unavailable" };
  if (/timeout/i.test(message)) return { kind: "down", code: "timeout" };
  if (/terminated|ended unexpectedly|Connection closed/i.test(message)) return { kind: "down", code: "connection_lost" };
  return { kind: "refused", code: "internal_error" };
}
