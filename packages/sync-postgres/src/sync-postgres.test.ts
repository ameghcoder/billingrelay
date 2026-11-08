import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./destination";
import { classifyDestinationError } from "./errors";
import { destinationUrlProblem } from "./tls";

const pgError = (code: string, message = "boom") => Object.assign(new Error(message), { code });

describe("classifyDestinationError", () => {
  it.each([
    ["08006", "down"],
    ["57P01", "down"],
    ["57P03", "down"],
    ["53300", "down"],
    ["57014", "down"],
    ["28P01", "not_ready"],
    ["3D000", "not_ready"],
    ["42501", "not_ready"],
    ["42P01", "not_ready"],
    ["3F000", "not_ready"],
    ["42703", "not_ready"],
    ["25006", "not_ready"],
    ["23505", "refused"],
    ["22003", "refused"],
    ["40001", "refused"],
  ])("SQLSTATE %s is %s", (code, kind) => {
    expect(classifyDestinationError(pgError(code)).kind).toBe(kind);
  });

  it("names what to fix for setup problems", () => {
    expect(classifyDestinationError(pgError("42501"))).toEqual({ kind: "not_ready", code: "permission_denied" });
    expect(classifyDestinationError(pgError("42P01"))).toEqual({ kind: "not_ready", code: "schema_mismatch" });
    expect(classifyDestinationError(pgError("28P01"))).toEqual({ kind: "not_ready", code: "login_rejected" });
  });

  it("treats an unreachable host and timeouts as down", () => {
    expect(classifyDestinationError(pgError("ECONNREFUSED"))).toEqual({ kind: "down", code: "unreachable" });
    expect(classifyDestinationError(pgError("ENOTFOUND"))).toEqual({ kind: "down", code: "unreachable" });
    expect(classifyDestinationError(new Error("Query read timeout"))).toEqual({ kind: "down", code: "timeout" });
    expect(classifyDestinationError(new Error("timeout exceeded when trying to connect"))).toEqual({ kind: "down", code: "timeout" });
    expect(classifyDestinationError(new Error("Connection terminated unexpectedly"))).toEqual({ kind: "down", code: "connection_lost" });
  });

  it("treats an untrusted certificate or no TLS as a setup problem, not an outage", () => {
    expect(classifyDestinationError(pgError("SELF_SIGNED_CERT_IN_CHAIN"))).toEqual({ kind: "not_ready", code: "tls_unverified" });
    expect(classifyDestinationError(new Error("The server does not support SSL connections"))).toEqual({ kind: "not_ready", code: "tls_unavailable" });
  });

  it("never passes the error's text on", () => {
    const failure = classifyDestinationError(pgError("23505", "Key (external_customer_id)=(buyer@example.com) already exists"));
    expect(JSON.stringify(failure)).not.toContain("example.com");
    expect(classifyDestinationError(new Error("something odd at db.example.com"))).toEqual({ kind: "refused", code: "internal_error" });
    expect(classifyDestinationError("not an error")).toEqual({ kind: "refused", code: "internal_error" });
  });
});

describe("destinationUrlProblem", () => {
  it("allows this machine without TLS", () => {
    expect(destinationUrlProblem("postgres://u:p@localhost:5434/merchant")).toBeNull();
    expect(destinationUrlProblem("postgres://u:p@127.0.0.1:5434/merchant")).toBeNull();
    expect(destinationUrlProblem("postgres://u:p@[::1]:5434/merchant")).toBeNull();
  });

  it("requires TLS with a verified certificate anywhere else", () => {
    expect(destinationUrlProblem("postgres://u:p@db.example.com/merchant")).toBe("tls_required");
    expect(destinationUrlProblem("postgres://u:p@db.example.com/merchant?sslmode=disable")).toBe("tls_required");
    expect(destinationUrlProblem("postgres://u:p@db.example.com/merchant?ssl=false")).toBe("tls_required");
    expect(destinationUrlProblem("postgres://u:p@db.example.com/merchant?sslmode=no-verify")).toBe("tls_unverified");
    expect(destinationUrlProblem("postgres://u:p@db.example.com/merchant?uselibpqcompat=true&sslmode=require")).toBe("tls_unverified");
    expect(destinationUrlProblem("postgres://u:p@db.example.com/merchant?sslmode=verify-full")).toBeNull();
    expect(destinationUrlProblem("postgres://u:p@db.example.com/merchant?ssl=true")).toBeNull();
  });

  it("refuses what it can't read", () => {
    expect(destinationUrlProblem("not a url")).toBe("url_invalid");
    expect(destinationUrlProblem("postgres://u:p@db.example.com/m?sslmode=verify-full&sslrootcert=/no/such/file")).toBe("url_invalid");
  });
});

describe("migrations", () => {
  it("end at the version the worker writes to, numbered without gaps", () => {
    const folder = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
    const versions = readdirSync(folder)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => Number(name.slice(0, 3)));
    expect(versions).toEqual(Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
  });
});
