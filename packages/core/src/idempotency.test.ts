import { describe, expect, it } from "vitest";
import { hashPayload, idempotencyKeySchema } from "./idempotency";

describe("hashPayload", () => {
  it("ignores key order, at every depth", () => {
    expect(hashPayload({ a: 1, b: { c: 2, d: [{ e: 3, f: 4 }] } })).toBe(hashPayload({ b: { d: [{ f: 4, e: 3 }], c: 2 }, a: 1 }));
  });

  it("ignores undefined values, which never reach the JSON", () => {
    expect(hashPayload({ a: 1, b: undefined })).toBe(hashPayload({ a: 1 }));
  });

  it.each<[string, unknown, unknown]>([
    ["a different value", { a: 1 }, { a: 2 }],
    ["a number and its text", { a: 1 }, { a: "1" }],
    ["array order", { a: [1, 2] }, { a: [2, 1] }],
    ["a missing key and null", { a: null }, {}],
    ["a nested value moved up", { a: { b: 1 } }, { a: 1, b: 1 }],
    ["text that looks like JSON structure", { a: '1,"b":2' }, { a: 1, b: 2 }],
  ])("tells apart %s", (_name, left, right) => {
    expect(hashPayload(left)).not.toBe(hashPayload(right));
  });
});

describe("idempotencyKeySchema", () => {
  it.each(["a", "order-1234", "A_b.c:d/e", "x".repeat(255)])("accepts %j", (key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(true);
  });

  it.each(["", "has space", "x".repeat(256), "naïve", "tab\there", null])("refuses %j", (key) => {
    expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});
