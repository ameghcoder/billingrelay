import { parse } from "pg-connection-string";

const isLocalHost = (host: string) => host === "localhost" || host === "::1" || host.startsWith("127.") || host.startsWith("/");

/**
 * Null when the URL is acceptable. Anything beyond this machine needs TLS with a verified certificate,
 * because the merchant's database login crosses the network. Read the way node-postgres reads it.
 */
export function destinationUrlProblem(url: string): string | null {
  if (!/^postgres(ql)?:\/\//.test(url)) return "url_invalid";
  let config: ReturnType<typeof parse>;
  try {
    config = parse(url);
  } catch {
    // Also a `sslrootcert` file that can't be read.
    return "url_invalid";
  }
  if (!config.host) return "url_invalid";
  if (isLocalHost(config.host)) return null;

  const { ssl } = config;
  if (ssl === true) return null;
  if (typeof ssl !== "object" || ssl === null) return "tls_required";
  return ssl.rejectUnauthorized === false ? "tls_unverified" : null;
}
