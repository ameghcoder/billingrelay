import { isIP } from "node:net";

export type RateRule = { name: string; max: number; windowSeconds: number };
export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

type Window = { count: number; resetAt: number };

const MAX_KEYS = 50_000;

/** Fixed windows in this process's memory. One web instance shares one limiter; several instances each count separately. */
export function createRateLimiter(now: () => number = Date.now) {
  const windows = new Map<string, Window>();

  const current = (rule: RateRule, key: string) => {
    const id = `${rule.name}\0${key}`;
    const window = windows.get(id);
    if (window && window.resetAt > now()) return { id, window };
    windows.delete(id);
    return { id, window: null };
  };

  const refused = (window: Window): RateDecision => ({
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now()) / 1000)),
  });

  // A flood of new keys must not grow memory without end. Expired windows go first, then the oldest tenth, so a full sweep
  // happens at most once per MAX_KEYS / 10 new keys, not on every request.
  const makeRoom = () => {
    if (windows.size < MAX_KEYS) return;
    const time = now();
    for (const [id, window] of windows) if (window.resetAt <= time) windows.delete(id);
    const target = MAX_KEYS - MAX_KEYS / 10;
    for (const id of windows.keys()) {
      if (windows.size <= target) break;
      windows.delete(id);
    }
  };

  return {
    /** Counts this request, and says whether it may go ahead. */
    hit(rule: RateRule, key: string): RateDecision {
      const { id, window } = current(rule, key);
      if (window) {
        if (window.count >= rule.max) return refused(window);
        window.count += 1;
        return { allowed: true };
      }
      makeRoom();
      windows.set(id, { count: 1, resetAt: now() + rule.windowSeconds * 1000 });
      return { allowed: true };
    },
    /** Says whether the limit is already reached, without counting. For limits that count only failures. */
    check(rule: RateRule, key: string): RateDecision {
      const { window } = current(rule, key);
      return window && window.count >= rule.max ? refused(window) : { allowed: true };
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

/**
 * The client's address from the one header this deployment's proxy sets. No header named, or no single valid
 * address in it, gives one shared key: a header a client can set itself is never trusted.
 */
export function clientIpFrom(headers: Headers, trustedHeader: string | undefined): string {
  if (!trustedHeader) return "shared";
  const value = headers.get(trustedHeader)?.trim() ?? "";
  return isIP(value) ? value : "shared";
}
