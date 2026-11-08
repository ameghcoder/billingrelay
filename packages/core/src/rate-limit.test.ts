import { describe, expect, it } from "vitest";
import { clientIpFrom, createRateLimiter } from "./rate-limit";

const rule = { name: "test", max: 3, windowSeconds: 60 };

function limiterAt(start = 1_000_000) {
  const clock = { now: start };
  return { clock, limiter: createRateLimiter(() => clock.now) };
}

describe("createRateLimiter", () => {
  it("allows up to the limit, then refuses with the seconds left", () => {
    const { clock, limiter } = limiterAt();
    expect([1, 2, 3].map(() => limiter.hit(rule, "a").allowed)).toEqual([true, true, true]);
    clock.now += 20_000;
    expect(limiter.hit(rule, "a")).toEqual({ allowed: false, retryAfterSeconds: 40 });
  });

  it("starts a new window once the old one ends", () => {
    const { clock, limiter } = limiterAt();
    for (let i = 0; i < 4; i++) limiter.hit(rule, "a");
    clock.now += 60_000;
    expect(limiter.hit(rule, "a").allowed).toBe(true);
  });

  it("counts each key and each rule on its own", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 3; i++) limiter.hit(rule, "a");
    expect(limiter.hit(rule, "b").allowed).toBe(true);
    expect(limiter.hit({ ...rule, name: "other" }, "a").allowed).toBe(true);
    expect(limiter.hit(rule, "a").allowed).toBe(false);
  });

  it("check never counts, so only failures use up a failure limit", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 10; i++) expect(limiter.check(rule, "a").allowed).toBe(true);
    for (let i = 0; i < 3; i++) limiter.hit(rule, "a");
    expect(limiter.check(rule, "a").allowed).toBe(false);
  });

  it("refused requests don't stretch the window", () => {
    const { clock, limiter } = limiterAt();
    for (let i = 0; i < 3; i++) limiter.hit(rule, "a");
    for (let i = 0; i < 50; i++) {
      clock.now += 1_000;
      limiter.hit(rule, "a");
    }
    clock.now += 10_000;
    expect(limiter.hit(rule, "a").allowed).toBe(true);
  });

  it("keeps memory bounded, and stays fast, under a flood of new keys", () => {
    const { limiter } = limiterAt();
    const started = performance.now();
    for (let i = 0; i < 200_000; i++) limiter.hit(rule, `key-${i}`);
    // Was a full sweep per new key once full: about 20s for 60,000 keys on a busy machine.
    expect(performance.now() - started).toBeLessThan(2_000);
    // The newest keys are still counted.
    for (let i = 0; i < 2; i++) limiter.hit(rule, "key-199999");
    expect(limiter.hit(rule, "key-199999").allowed).toBe(false);
  });
});

describe("clientIpFrom", () => {
  const headers = (value: string) => new Headers({ "x-client-ip": value, "x-forwarded-for": "203.0.113.9" });

  it("reads only the named header", () => {
    expect(clientIpFrom(headers("198.51.100.7"), "x-client-ip")).toBe("198.51.100.7");
    expect(clientIpFrom(headers("2001:db8::1"), "x-client-ip")).toBe("2001:db8::1");
  });

  it("never trusts X-Forwarded-For unless it's the named header", () => {
    expect(clientIpFrom(headers("198.51.100.7"), undefined)).toBe("shared");
  });

  it("gives the shared key for a list, junk or a missing header", () => {
    expect(clientIpFrom(headers("198.51.100.7, 203.0.113.9"), "x-client-ip")).toBe("shared");
    expect(clientIpFrom(headers("not-an-ip"), "x-client-ip")).toBe("shared");
    expect(clientIpFrom(new Headers(), "x-client-ip")).toBe("shared");
  });
});
