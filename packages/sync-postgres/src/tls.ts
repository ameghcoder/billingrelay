import { parse } from "pg-connection-string";

import { isIP } from "node:net";

const isLocalHost = (host: string) => host === "localhost" || host === "::1" || host.startsWith("127.") || host.startsWith("/");

/**
 * A name only a private network resolves (one word, such as Render's `dpg-…-a` or a Docker service), or a private address.
 * Never a public name: those resolve from anywhere, so the login would cross networks we don't control.
 */
export function isPrivateHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) {
    const [a, b] = bare.split(".").map(Number) as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(bare) === 6) return /^f[cd]/i.test(bare);
  return /^[a-z0-9-]+$/i.test(bare);
}

/**
 * Null when the URL is acceptable. Anything beyond this machine needs TLS with a verified certificate,
 * because the merchant's database login crosses the network. Read the way node-postgres reads it.
 * `privateNetwork` (the operator's explicit `DESTINATION_PRIVATE_NETWORK=1`) also allows a private host without TLS.
 */
export function destinationUrlProblem(url: string, { privateNetwork = false } = {}): string | null {
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
  if (privateNetwork && isPrivateHost(config.host)) return null;

  const { ssl } = config;
  if (ssl === true) return null;
  if (typeof ssl !== "object" || ssl === null) return "tls_required";
  return ssl.rejectUnauthorized === false ? "tls_unverified" : null;
}
