import type { Account, AccountUsageLimit } from "@renki/protocol";
import { describe, expect, it } from "vitest";
import { MIN_WAIT_MS, RESET_BUFFER_MS, accountFreeAt, backoffMs, planResume } from "../src/accounts/resumePlan.js";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function limit(overrides: Partial<AccountUsageLimit>): AccountUsageLimit {
  return { kind: "session", label: "Session usage", model: null, pct: 10, resetsAt: null, severity: "normal", isActive: true, ...overrides };
}

function account(overrides: Partial<Account> & { limits?: AccountUsageLimit[] } = {}): Account {
  const { limits = [], ...rest } = overrides;
  return {
    number: 1,
    email: "a@example.com",
    active: false,
    usageStatus: "ok",
    usageError: null,
    usage: { fiveHour: { pct: 10, resetsAt: null }, sevenDay: { pct: 10, resetsAt: null }, limits, extra: null },
    ...rest,
  };
}

const base = { rotationEnabled: true, model: "opus", hit: null, attempt: 0, now: NOW };

describe("accountFreeAt", () => {
  it("is free now when nothing is exhausted", () => {
    expect(accountFreeAt(account({ limits: [limit({ pct: 80, resetsAt: inHours(1) })] }), "opus", NOW)?.at).toBe(NOW);
  });

  /** Every exhausted limit has to clear before the account can work again. */
  it("waits for the latest reset among the exhausted limits", () => {
    const a = account({
      limits: [
        limit({ kind: "session", pct: 100, resetsAt: inHours(2) }),
        limit({ kind: "weekly_all", label: "All models", pct: 100, resetsAt: inHours(30) }),
      ],
    });
    expect(accountFreeAt(a, "opus", NOW)).toEqual({ at: NOW + 30 * 3_600_000, name: "the weekly limit" });
  });

  it("ignores another model's weekly cap", () => {
    const a = account({ limits: [limit({ kind: "weekly_scoped", label: "Fable", model: "Fable", pct: 100, resetsAt: inHours(40) })] });
    expect(accountFreeAt(a, "claude-opus-5-5", NOW)?.at).toBe(NOW);
    expect(accountFreeAt(a, "claude-fable-5-1[1m]", NOW)?.at).toBe(NOW + 40 * 3_600_000);
  });

  /** The usage reader caches: at the moment a resume comes due, the cached 100% is exactly what's stale. */
  it("treats a limit whose reset has passed as cleared, whatever the cached percentage", () => {
    const a = account({ limits: [limit({ pct: 100, resetsAt: inHours(-0.1) })] });
    expect(accountFreeAt(a, "opus", NOW)?.at).toBe(NOW);
  });

  it("knows nothing without usage", () => {
    expect(accountFreeAt(account({ usageStatus: "unavailable", usage: null }), "opus", NOW)).toBeNull();
  });

  it("falls back to the two legacy windows on older usage responses", () => {
    const a = account({ usage: { fiveHour: { pct: 100, resetsAt: inHours(3) }, sevenDay: { pct: 20, resetsAt: null }, limits: [], extra: null } });
    expect(accountFreeAt(a, "opus", NOW)).toEqual({ at: NOW + 3 * 3_600_000, name: "the 5-hour limit" });
  });
});

describe("planResume", () => {
  it("waits for the CLI's reported reset on a single account", () => {
    const plan = planResume({ ...base, accounts: [], hit: { resetsAt: NOW + 3_600_000, type: "five_hour" } });
    expect(plan).toEqual({ at: NOW + 3_600_000 + RESET_BUFFER_MS, reason: "Waiting for the 5-hour limit to reset." });
  });

  /** The whole point of multi-account: whichever login frees up first takes the turn. */
  it("picks the earliest reset across accounts, and names the account", () => {
    const plan = planResume({
      ...base,
      accounts: [
        account({ number: 1, email: "a@example.com", active: true, limits: [limit({ pct: 100, resetsAt: inHours(4) })] }),
        account({ number: 2, email: "b@example.com", limits: [limit({ kind: "weekly_all", pct: 100, resetsAt: inHours(1) })] }),
      ],
    });
    expect(plan.at).toBe(NOW + 3_600_000 + RESET_BUFFER_MS);
    expect(plan.reason).toBe("Waiting for the weekly limit on b@example.com to reset.");
  });

  /** With rotation off Renki never changes account, so another login's reset is irrelevant. */
  it("only considers the active account with rotation off", () => {
    const plan = planResume({
      ...base,
      rotationEnabled: false,
      accounts: [
        account({ number: 1, email: "a@example.com", active: true, limits: [limit({ pct: 100, resetsAt: inHours(4) })] }),
        account({ number: 2, email: "b@example.com", limits: [limit({ pct: 100, resetsAt: inHours(1) })] }),
      ],
    });
    expect(plan.at).toBe(NOW + 4 * 3_600_000 + RESET_BUFFER_MS);
    expect(plan.reason).toBe("Waiting for the 5-hour limit to reset.");
  });

  /** The turn just failed on the active account, so usage saying "fine" there is stale — trust the CLI. */
  it("prefers the CLI's report for the active account over usage that says it's free", () => {
    const plan = planResume({
      ...base,
      accounts: [account({ active: true, limits: [limit({ pct: 60 })] })],
      hit: { resetsAt: NOW + 2 * 3_600_000, type: "seven_day" },
    });
    expect(plan.at).toBe(NOW + 2 * 3_600_000 + RESET_BUFFER_MS);
    expect(plan.reason).toContain("the weekly limit");
  });

  it("comes back soon for another account that already has room", () => {
    const plan = planResume({
      ...base,
      accounts: [
        account({ number: 1, active: true, limits: [limit({ pct: 100, resetsAt: inHours(4) })] }),
        account({ number: 2, email: "b@example.com", limits: [limit({ pct: 20 })] }),
      ],
    });
    expect(plan.at).toBe(NOW + 60_000);
    expect(plan.reason).toBe("b@example.com has room, so switching to it shortly.");
  });

  it("backs off when nothing says when the limit resets", () => {
    expect(planResume({ ...base, accounts: [] })).toMatchObject({ at: NOW + 15 * 60_000 });
    expect(planResume({ ...base, accounts: [], attempt: 1 }).at).toBe(NOW + 30 * 60_000);
    expect(backoffMs(10)).toBe(2 * 3_600_000);
  });

  it("never schedules sooner than the minimum wait", () => {
    const plan = planResume({ ...base, accounts: [], hit: { resetsAt: NOW + 1_000, type: null } });
    expect(plan.at).toBeGreaterThanOrEqual(NOW + MIN_WAIT_MS);
  });
});
