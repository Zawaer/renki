import type { Account, AccountsResponse, RotationStatus, SwitchAccountResponse } from "@crc/protocol";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import type { SessionManager } from "../sessions/manager.js";
import { Cswap } from "./cswap.js";
import type { UsageReader } from "./usage.js";

/**
 * Automates the manual "hit the limit, run cswap --switch, keep going" habit.
 *
 * cswap does the mechanics (usage + the lock-safe credential swap); the rotator
 * owns only the POLICY of when to swap:
 *   - switch when the active account's 5h or 7d usage ≥ threshold,
 *   - to an account that actually has headroom,
 *   - respecting a cooldown so it can't flip-flop,
 *   - FAIL SAFE: if usage is unavailable or cswap errors, hold (never switch
 *     blind),
 *   - NEVER mid-flight: defer while any session is running a turn, because a
 *     live `claude` process could otherwise refresh its token against the wrong
 *     account. Because we use resume-per-prompt, the swap lands cleanly and the
 *     next turn of any session simply starts on the new account.
 *
 * The swap is global (it changes the active account for every future turn),
 * which is exactly the manual behavior being automated.
 */
export class AccountRotator {
  private readonly cswap: Cswap;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSwitchAt: number | null = null;
  private lastHoldReason: string | null = null;
  private ticking = false;

  constructor(
    private readonly config: Config,
    private readonly manager: SessionManager,
    private readonly usage: UsageReader,
  ) {
    this.cswap = new Cswap(config.rotation.cswapBin);
  }

  /** Auto-retry (switch + re-run) is only attempted when rotation is enabled. */
  get autoRetryEnabled(): boolean {
    return this.config.rotation.enabled && this.config.rotation.autoRetry;
  }

  /** cswap accounts with real usage merged in from the usage reader, by email. */
  private async mergedAccounts(): Promise<{ activeAccountNumber: number | null; accounts: Account[] }> {
    const { activeAccountNumber, accounts } = await this.cswap.list();
    if (!this.usage.configured) return { activeAccountNumber, accounts };
    const byEmail = await this.usage.usageByEmail();
    const merged = accounts.map((a) => {
      const u = byEmail.get(a.email.toLowerCase());
      return u ? { ...a, usage: u, usageStatus: "ok" } : a;
    });
    return { activeAccountNumber, accounts: merged };
  }

  /**
   * Hard rate-limit trigger: a turn actually failed with a rate limit, so switch
   * now regardless of usage numbers (which we may not even have). The caller
   * limits this to once per prompt, so there's no flip-flop risk.
   */
  async rateLimitSwitch(): Promise<{ switched: boolean; active: number | null }> {
    const { accounts } = await this.cswap.list();
    if (accounts.length < 2) return { switched: false, active: null };
    try {
      const active = await this.cswap.switch(this.config.rotation.strategy);
      this.lastSwitchAt = Date.now();
      logger.info("rate-limit switch", { active });
      return { switched: true, active };
    } catch (err) {
      logger.warn("rate-limit switch failed", { err: String(err) });
      return { switched: false, active: null };
    }
  }

  start(): void {
    if (!this.config.rotation.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.config.rotation.pollMs);
    this.timer.unref();
    logger.info("account rotation enabled", {
      threshold: this.config.rotation.threshold,
      cooldownMin: this.config.rotation.cooldownMs / 60_000,
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Snapshot for GET /accounts: live usage + current rotation policy state. */
  async snapshot(): Promise<AccountsResponse> {
    const { activeAccountNumber, accounts } = await this.mergedAccounts();
    return {
      activeAccountNumber,
      accounts,
      rotation: this.status(),
      usageConfigured: this.usage.configured,
      usageConnectedEmails: this.usage.connectedEmails(),
    };
  }

  /** Email of the currently active cswap account, used as a usage-key hint. */
  async activeEmail(): Promise<string | undefined> {
    try {
      const { accounts } = await this.cswap.list();
      return accounts.find((a) => a.active)?.email || undefined;
    } catch {
      return undefined;
    }
  }

  /** Manual switch (REST). Honors the never-mid-flight rule too. */
  async manualSwitch(to?: number | string): Promise<SwitchAccountResponse> {
    if (this.anyBusy()) {
      return { ok: false, activeAccountNumber: null, message: "A session is mid-turn; try again in a moment." };
    }
    try {
      const active =
        to === undefined ? await this.cswap.switch(this.config.rotation.strategy) : await this.cswap.switchTo(to);
      this.lastSwitchAt = Date.now();
      logger.info("manual account switch", { active });
      return { ok: true, activeAccountNumber: active, message: null };
    } catch (err) {
      return { ok: false, activeAccountNumber: null, message: err instanceof Error ? err.message : "switch failed" };
    }
  }

  private status(): RotationStatus {
    return {
      enabled: this.config.rotation.enabled,
      threshold: this.config.rotation.threshold,
      cooldownMs: this.config.rotation.cooldownMs,
      lastSwitchAt: this.lastSwitchAt,
      lastHoldReason: this.lastHoldReason,
    };
  }

  /** Run one evaluation. Called on the interval; also exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return; // don't overlap slow cswap calls
    this.ticking = true;
    try {
      await this.evaluate();
    } catch (err) {
      // FAIL SAFE: any error → keep the current account.
      this.lastHoldReason = "usage check failed";
      logger.warn("rotation check failed; holding", { err: String(err) });
    } finally {
      this.ticking = false;
    }
  }

  private async evaluate(): Promise<void> {
    const { threshold, cooldownMs, strategy } = this.config.rotation;
    const { accounts } = await this.mergedAccounts();

    const active = accounts.find((a) => a.active);
    if (!active) return this.hold("no active account");
    if (active.usageStatus !== "ok" || !active.usage) return this.hold("usage unavailable");

    const worst = Math.max(active.usage.fiveHour.pct, active.usage.sevenDay.pct);
    if (worst < threshold) return this.hold(null); // healthy — nothing to do

    // A switch only helps if another account actually has room.
    const hasHeadroom = accounts.some(
      (a) => !a.active && a.usageStatus === "ok" && a.usage && Math.max(a.usage.fiveHour.pct, a.usage.sevenDay.pct) < threshold,
    );
    if (!hasHeadroom) return this.hold("all accounts at limit");

    if (this.lastSwitchAt && Date.now() - this.lastSwitchAt < cooldownMs) return this.hold("cooldown");

    // Never swap while a turn is live — defer to a later tick.
    if (this.anyBusy()) return this.hold("session busy");

    const newActive = await this.cswap.switch(strategy);
    this.lastSwitchAt = Date.now();
    this.lastHoldReason = null;
    logger.info("auto-rotated account", { from: active.number, to: newActive, worstPct: worst });
  }

  private hold(reason: string | null): void {
    this.lastHoldReason = reason;
  }

  private anyBusy(): boolean {
    return this.manager.listSessions().some((s) => s.status === "busy");
  }
}
