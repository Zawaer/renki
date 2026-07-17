import type { AccountsResponse, RotationStatus, SwitchAccountResponse } from "@crc/protocol";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import type { SessionManager } from "../sessions/manager.js";
import { Cswap } from "./cswap.js";

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
  ) {
    this.cswap = new Cswap(config.rotation.cswapBin);
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
    const { activeAccountNumber, accounts } = await this.cswap.list();
    return { activeAccountNumber, accounts, rotation: this.status() };
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
    const { accounts } = await this.cswap.list();

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
