import { readFileSync, writeFileSync } from "node:fs";
import type { Account } from "@renki/protocol";
import { describe, expect, it, vi } from "vitest";
import { AccountRotator } from "../src/accounts/rotator.js";
import type { SessionManager } from "../src/sessions/manager.js";
import type { UsageReader } from "../src/accounts/usage.js";
import { makeTestConfig } from "./helpers.js";

/**
 * The rotator's `Cswap` instance is created internally (`new Cswap(bin)`),
 * not injected — same private-field-swap pattern usage.test.ts uses for its
 * unmockable HTTP client, since `Cswap` shells out to the real `cswap`
 * binary via `execFile`/`spawn` and isn't mockable via fetch interception.
 */
function fakeCswap(overrides: {
  list?: () => Promise<{ activeAccountNumber: number | null; accounts: Account[] }>;
  switch?: () => Promise<number | null>;
  switchTo?: (target: number | string) => Promise<number | null>;
  addToken?: (token: string) => Promise<void>;
}) {
  return {
    list: vi.fn(overrides.list ?? (async () => ({ activeAccountNumber: null, accounts: [] }))),
    switch: vi.fn(overrides.switch ?? (async () => null)),
    switchTo: vi.fn(overrides.switchTo ?? (async () => null)),
    addToken: vi.fn(overrides.addToken ?? (async () => {})),
  };
}

/** usage.configured: false means mergedAccounts() trusts cswap.list()'s own usage/usageStatus fields as-is. */
function fakeUsage(): UsageReader {
  return {
    configured: false,
    usageByEmail: vi.fn(async () => new Map()),
    connectedEmails: vi.fn(() => []),
  } as unknown as UsageReader;
}

function fakeManager(busy: boolean): SessionManager {
  return { listSessions: () => (busy ? [{ status: "busy" }] : [{ status: "idle" }]) } as unknown as SessionManager;
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    number: 1,
    email: "a@example.com",
    active: false,
    usageStatus: "ok",
    usage: { fiveHour: { pct: 10, resetsAt: null }, sevenDay: { pct: 10, resetsAt: null }, extra: null },
    ...overrides,
  };
}

/** Builds a rotator with the real policy logic but a fully fake Cswap, config, manager, and usage reader. */
function setup(opts: {
  accounts: Account[];
  activeAccountNumber?: number | null;
  busy?: boolean;
  threshold?: number;
  cooldownMs?: number;
  lastSwitchAt?: number | null;
  switchImpl?: () => Promise<number | null>;
}) {
  const config = makeTestConfig({
    rotation: {
      enabled: true,
      cswapBin: "cswap",
      threshold: opts.threshold ?? 90,
      cooldownMs: opts.cooldownMs ?? 5 * 60_000,
      pollMs: 60_000,
      strategy: "best",
      autoRetry: true,
    },
  });
  const cswap = fakeCswap({
    list: async () => ({ activeAccountNumber: opts.activeAccountNumber ?? null, accounts: opts.accounts }),
    switch: opts.switchImpl,
  });
  const rotator = new AccountRotator(config, fakeManager(opts.busy ?? false), fakeUsage());
  (rotator as any).cswap = cswap;
  if (opts.lastSwitchAt !== undefined) (rotator as any).lastSwitchAt = opts.lastSwitchAt;
  return { rotator, cswap, config };
}

describe("AccountRotator.evaluate (via tick)", () => {
  it("holds without switching when rotation is disabled", async () => {
    const { rotator, cswap } = setup({ accounts: [account({ active: true, usage: { fiveHour: { pct: 99, resetsAt: null }, sevenDay: { pct: 10, resetsAt: null }, extra: null } })] });
    (rotator as any).enabled = false;
    await rotator.tick();
    expect(cswap.switch).not.toHaveBeenCalled();
    expect(rotator.status().lastHoldReason).toBe("disabled");
  });

  /**
   * cswap reports nothing active when the credential in use doesn't match a
   * snapshot it registered (a Claude Code token refresh leaves the new blob
   * "unclaimed"). Sessions keep working, so it reads as cosmetic — but every
   * rotation decision is relative to the active account, so the feature goes
   * silently inert. Claiming one is what keeps auto-switch actually automatic.
   */
  it("claims an account when cswap reports none active, instead of stalling forever", async () => {
    const { rotator, cswap } = setup({ accounts: [account({ number: 4, active: false })] });
    await rotator.tick();
    expect(cswap.switchTo).toHaveBeenCalledWith(4);
    expect(rotator.status().lastHoldReason).toBeNull();
  });

  it("claims the preferred account when nothing is active and it has headroom", async () => {
    const { rotator, cswap } = setup({
      accounts: [
        account({ number: 1, email: "fallback@example.com", active: false }),
        account({ number: 3, email: "preferred@example.com", active: false }),
      ],
    });
    (rotator as any).preferredEmail = "preferred@example.com";
    await rotator.tick();
    expect(cswap.switchTo).toHaveBeenCalledWith(3);
  });

  /** Being on a known account at its limit still beats being on none — rotation can at least see the limit and act. */
  it("still claims an account when every one is over the threshold", async () => {
    const over = { fiveHour: { pct: 99, resetsAt: null }, sevenDay: { pct: 99, resetsAt: null }, extra: null };
    const { rotator, cswap } = setup({
      threshold: 90,
      accounts: [
        account({ number: 1, email: "fallback@example.com", active: false, usage: over }),
        account({ number: 3, email: "preferred@example.com", active: false, usage: over }),
      ],
    });
    (rotator as any).preferredEmail = "preferred@example.com";
    await rotator.tick();
    expect(cswap.switchTo).toHaveBeenCalledWith(3);
  });

  it("never claims mid-turn — a swap changes which credentials the next process loads", async () => {
    const { rotator, cswap } = setup({ accounts: [account({ active: false })], busy: true });
    await rotator.tick();
    expect(cswap.switchTo).not.toHaveBeenCalled();
    expect(rotator.status().lastHoldReason).toBe("session busy");
  });

  /** Bounds the retry rate: a switchTo that fails to stick would otherwise hammer cswap every tick. */
  it("rate-limits claiming with the same cooldown as any other switch", async () => {
    const { rotator, cswap } = setup({
      accounts: [account({ active: false })],
      cooldownMs: 5 * 60_000,
      lastSwitchAt: Date.now() - 60_000,
    });
    await rotator.tick();
    expect(cswap.switchTo).not.toHaveBeenCalled();
    expect(rotator.status().lastHoldReason).toBe("cooldown");
  });

  it("holds when there are no accounts at all", async () => {
    const { rotator, cswap } = setup({ accounts: [] });
    await rotator.tick();
    expect(cswap.switchTo).not.toHaveBeenCalled();
    expect(rotator.status().lastHoldReason).toBe("no accounts configured");
  });

  it("holds when the active account's usage is unavailable", async () => {
    const { rotator, cswap } = setup({ accounts: [account({ active: true, usageStatus: "unavailable", usage: null })] });
    await rotator.tick();
    expect(cswap.switch).not.toHaveBeenCalled();
    expect(rotator.status().lastHoldReason).toBe("usage unavailable");
  });

  it("holds (healthy, reason null) when usage is under the threshold", async () => {
    const { rotator, cswap } = setup({
      threshold: 90,
      accounts: [account({ active: true, usage: { fiveHour: { pct: 50, resetsAt: null }, sevenDay: { pct: 60, resetsAt: null }, extra: null } })],
    });
    await rotator.tick();
    expect(cswap.switch).not.toHaveBeenCalled();
    expect(rotator.status().lastHoldReason).toBeNull();
  });

  it("holds when over threshold but no other account has headroom", async () => {
    const over = { fiveHour: { pct: 95, resetsAt: null }, sevenDay: { pct: 95, resetsAt: null }, extra: null };
    const { rotator, cswap } = setup({
      threshold: 90,
      accounts: [account({ number: 1, active: true, usage: over }), account({ number: 2, email: "b@example.com", active: false, usage: over })],
    });
    await rotator.tick();
    expect(cswap.switch).not.toHaveBeenCalled();
    expect(rotator.status().lastHoldReason).toBe("all accounts at limit");
  });

  it("holds during cooldown even with headroom over threshold", async () => {
    const { rotator, cswap } = setup({
      threshold: 90,
      lastSwitchAt: Date.now(),
      cooldownMs: 5 * 60_000,
      accounts: [
        account({ number: 1, active: true, usage: { fiveHour: { pct: 95, resetsAt: null }, sevenDay: { pct: 10, resetsAt: null }, extra: null } }),
        account({ number: 2, email: "b@example.com", active: false }),
      ],
    });
    await rotator.tick();
    expect(cswap.switch).not.toHaveBeenCalled();
    expect(rotator.status().lastHoldReason).toBe("cooldown");
  });

  it("never switches mid-flight — holds 'session busy' even over threshold with headroom and no cooldown", async () => {
    const { rotator, cswap } = setup({
      threshold: 90,
      busy: true,
      accounts: [
        account({ number: 1, active: true, usage: { fiveHour: { pct: 95, resetsAt: null }, sevenDay: { pct: 10, resetsAt: null }, extra: null } }),
        account({ number: 2, email: "b@example.com", active: false }),
      ],
    });
    await rotator.tick();
    expect(cswap.switch).not.toHaveBeenCalled();
    expect(rotator.status().lastHoldReason).toBe("session busy");
  });

  it("switches when over threshold, headroom exists, no cooldown, and nothing is busy", async () => {
    const { rotator, cswap } = setup({
      threshold: 90,
      switchImpl: async () => 2,
      accounts: [
        account({ number: 1, active: true, usage: { fiveHour: { pct: 95, resetsAt: null }, sevenDay: { pct: 10, resetsAt: null }, extra: null } }),
        account({ number: 2, email: "b@example.com", active: false }),
      ],
    });
    await rotator.tick();
    expect(cswap.switch).toHaveBeenCalledWith("best");
    expect(rotator.status().lastHoldReason).toBeNull();
    expect(rotator.status().lastSwitchAt).not.toBeNull();
  });

  it("fails safe: holds 'usage check failed' when cswap.list() throws, and never switches", async () => {
    const config = makeTestConfig({ rotation: { enabled: true, cswapBin: "cswap", threshold: 90, cooldownMs: 0, pollMs: 60_000, strategy: "best", autoRetry: true } });
    const rotator = new AccountRotator(config, fakeManager(false), fakeUsage());
    const cswap = fakeCswap({
      list: async () => {
        throw new Error("cswap unreachable");
      },
    });
    (rotator as any).cswap = cswap;
    await rotator.tick();
    expect(cswap.switch).not.toHaveBeenCalled();
    expect(rotator.status().lastHoldReason).toBe("usage check failed");
  });
});

describe("AccountRotator.rateLimitSwitch", () => {
  it("does not switch with fewer than 2 accounts", async () => {
    const { rotator, cswap } = setup({ accounts: [account()] });
    const result = await rotator.rateLimitSwitch();
    expect(result).toEqual({ switched: false, active: null });
    expect(cswap.switch).not.toHaveBeenCalled();
  });

  it("switches unconditionally (regardless of usage numbers) with 2+ accounts", async () => {
    const { rotator, cswap } = setup({
      switchImpl: async () => 2,
      accounts: [account({ number: 1 }), account({ number: 2, email: "b@example.com" })],
    });
    const result = await rotator.rateLimitSwitch();
    expect(result).toEqual({ switched: true, active: 2 });
    expect(cswap.switch).toHaveBeenCalledOnce();
  });

  it("reports switched:false when cswap.switch() throws", async () => {
    const { rotator } = setup({
      accounts: [account({ number: 1 }), account({ number: 2, email: "b@example.com" })],
      switchImpl: async () => {
        throw new Error("switch failed");
      },
    });
    const result = await rotator.rateLimitSwitch();
    expect(result).toEqual({ switched: false, active: null });
  });
});

describe("AccountRotator.manualSwitch", () => {
  it("refuses while any session is busy", async () => {
    const { rotator, cswap } = setup({ accounts: [account()], busy: true });
    const result = await rotator.manualSwitch();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/mid-turn/);
    expect(cswap.switch).not.toHaveBeenCalled();
  });

  it("switches to the strategy pick when no target is given", async () => {
    const { rotator, cswap } = setup({ accounts: [account()], switchImpl: async () => 3 });
    const result = await rotator.manualSwitch();
    expect(result).toEqual({ ok: true, activeAccountNumber: 3, message: null });
    expect(cswap.switch).toHaveBeenCalledWith("best");
  });

  it("switches to a specific target account when given", async () => {
    const { rotator, cswap } = setup({ accounts: [account()] });
    const result = await rotator.manualSwitch(2);
    expect(result.ok).toBe(true);
    expect(cswap.switchTo).toHaveBeenCalledWith(2);
  });

  it("reports a failure message when cswap errors", async () => {
    const config = makeTestConfig({ rotation: { enabled: true, cswapBin: "cswap", threshold: 90, cooldownMs: 0, pollMs: 60_000, strategy: "best", autoRetry: true } });
    const rotator = new AccountRotator(config, fakeManager(false), fakeUsage());
    (rotator as any).cswap = fakeCswap({
      switch: async () => {
        throw new Error("boom");
      },
    });
    const result = await rotator.manualSwitch();
    expect(result.ok).toBe(false);
    expect(result.message).toBe("boom");
  });
});

describe("AccountRotator settings persistence", () => {
  it("persists updateSettings and a fresh instance loads them back", () => {
    const config = makeTestConfig({ rotation: { enabled: false, cswapBin: "cswap", threshold: 90, cooldownMs: 0, pollMs: 60_000, strategy: "best", autoRetry: true } });
    const rotator = new AccountRotator(config, fakeManager(false), fakeUsage());

    const status = rotator.updateSettings({ enabled: true, threshold: 75 });
    expect(status.enabled).toBe(true);
    expect(status.threshold).toBe(75);

    const persisted = JSON.parse(readFileSync(config.rotationConfigPath, "utf8"));
    expect(persisted).toEqual({ enabled: true, threshold: 75, preferredEmail: null });

    // A fresh instance pointed at the same path picks up the persisted override.
    const reloaded = new AccountRotator(config, fakeManager(false), fakeUsage());
    expect(reloaded.status().enabled).toBe(true);
    expect(reloaded.status().threshold).toBe(75);
  });

  it("ignores an out-of-range persisted threshold, keeping the config default", () => {
    const config = makeTestConfig({ rotation: { enabled: false, cswapBin: "cswap", threshold: 90, cooldownMs: 0, pollMs: 60_000, strategy: "best", autoRetry: true } });
    // updateSettings itself doesn't validate — loadSettings (on construction) does; write an
    // out-of-range value directly to the settings file to simulate a hand-edited/corrupted one.
    writeFileSync(config.rotationConfigPath, JSON.stringify({ enabled: true, threshold: 500 }));
    const rotator = new AccountRotator(config, fakeManager(false), fakeUsage());
    expect(rotator.status().threshold).toBe(90); // out-of-range (1-100) rejected, falls back to config default
    expect(rotator.status().enabled).toBe(true); // enabled is still honored independently
  });
});

describe("preferred account", () => {
  /**
   * The case this exists for: one login is used for coding, the other's quota
   * is reserved for chatting elsewhere. So Renki should sit on the preferred
   * account whenever it can work, borrow the other only while the preferred
   * is over the threshold, and come back the moment it resets.
   */
  const account = (number: number, email: string, active: boolean, pct: number): Account => ({
    number,
    email,
    active,
    usageStatus: "ok",
    usageError: null,
    usage: {
      fiveHour: { pct, resetsAt: null },
      sevenDay: { pct: 10, resetsAt: null },
      limits: [],
      extra: null,
    },
  });

  function setup(accounts: Account[]) {
    const config = makeTestConfig({
      rotation: { enabled: true, cswapBin: "cswap", threshold: 90, cooldownMs: 0, pollMs: 60_000, strategy: "best", autoRetry: true },
    });
    const rotator = new AccountRotator(config, fakeManager(false), fakeUsage());
    const switchTo = vi.fn(async (n: number) => n);
    const switchAny = vi.fn(async () => 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rotator as any).cswap = { list: async () => ({ activeAccountNumber: accounts.find((a) => a.active)?.number ?? null, accounts }), switchTo, switch: switchAny };
    return { rotator, switchTo, switchAny };
  }

  it("returns to the preferred account as soon as it has headroom", async () => {
    const { rotator, switchTo } = setup([account(1, "coding@example.com", false, 5), account(2, "chat@example.com", true, 20)]);
    rotator.updateSettings({ preferredEmail: "coding@example.com" });

    await rotator.tick();

    expect(switchTo).toHaveBeenCalledWith(1);
  });

  it("stays put when the preferred account is already active and healthy", async () => {
    const { rotator, switchTo, switchAny } = setup([account(1, "coding@example.com", true, 5), account(2, "chat@example.com", false, 20)]);
    rotator.updateSettings({ preferredEmail: "coding@example.com" });

    await rotator.tick();

    expect(switchTo).not.toHaveBeenCalled();
    expect(switchAny).not.toHaveBeenCalled();
  });

  it("falls back to the other account only once the preferred one is over the threshold", async () => {
    const { rotator, switchTo } = setup([account(1, "coding@example.com", true, 96), account(2, "chat@example.com", false, 20)]);
    rotator.updateSettings({ preferredEmail: "coding@example.com" });

    await rotator.tick();

    // Targets the fallback explicitly rather than letting cswap's strategy
    // possibly pick the reserved account back.
    expect(switchTo).toHaveBeenCalledWith(2);
  });

  it("holds when both are full rather than thrashing", async () => {
    const { rotator, switchTo, switchAny } = setup([account(1, "coding@example.com", true, 99), account(2, "chat@example.com", false, 97)]);
    rotator.updateSettings({ preferredEmail: "coding@example.com" });

    await rotator.tick();

    expect(switchTo).not.toHaveBeenCalled();
    expect(switchAny).not.toHaveBeenCalled();
    expect(rotator.updateSettings({}).lastHoldReason).toBe("all accounts at limit");
  });
});
