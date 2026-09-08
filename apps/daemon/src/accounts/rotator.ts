import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Account, AccountsResponse, RotationStatus, SwitchAccountResponse } from "@renki/protocol";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import type { SessionManager } from "../sessions/manager.js";
import { Cswap } from "./cswap.js";
import type { UsageReader } from "./usage.js";

type PersistedRotationSettings = { enabled?: boolean; threshold?: number; preferredEmail?: string | null };

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
  /** Runs after every successful account switch (auto, manual, or rate-limit) — see setOnSwitched. */
  private onSwitched: (() => void) | null = null;
  private lastHoldReason: string | null = null;
  private ticking = false;
  /** Live-mutable policy — seeded from config, then a persisted override (if any), then editable from Settings. */
  private enabled: boolean;
  private threshold: number;
  /** Lower-cased email of the account to run as whenever it has headroom; null = no preference. */
  private preferredEmail: string | null = null;

  constructor(
    private readonly config: Config,
    private readonly manager: SessionManager,
    private readonly usage: UsageReader,
  ) {
    this.cswap = new Cswap(config.rotation.cswapBin);
    this.enabled = config.rotation.enabled;
    this.threshold = config.rotation.threshold;
    this.loadSettings();
  }

  /** Auto-retry (switch + re-run) is only attempted when rotation is enabled. */
  get autoRetryEnabled(): boolean {
    return this.enabled && this.config.rotation.autoRetry;
  }

  private loadSettings(): void {
    const path = this.config.rotationConfigPath;
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as PersistedRotationSettings;
      if (typeof raw.enabled === "boolean") this.enabled = raw.enabled;
      if (typeof raw.threshold === "number" && raw.threshold >= 1 && raw.threshold <= 100) this.threshold = raw.threshold;
      if (typeof raw.preferredEmail === "string" || raw.preferredEmail === null) this.preferredEmail = raw.preferredEmail;
    } catch (err) {
      logger.warn("could not read rotation config", { path, err: String(err) });
    }
  }

  private persistSettings(): void {
    const path = this.config.rotationConfigPath;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const body: PersistedRotationSettings = { enabled: this.enabled, threshold: this.threshold, preferredEmail: this.preferredEmail };
      writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      logger.warn("could not write rotation config", { path, err: String(err) });
    }
  }

  /** Update the rotation policy from Settings. Persists so it survives a restart. */
  updateSettings(patch: { enabled?: boolean; threshold?: number; preferredEmail?: string | null }): RotationStatus {
    if (patch.enabled !== undefined) this.enabled = patch.enabled;
    if (patch.preferredEmail !== undefined) this.preferredEmail = patch.preferredEmail?.toLowerCase() || null;
    if (patch.threshold !== undefined) this.threshold = patch.threshold;
    this.persistSettings();
    logger.info("rotation settings updated", { enabled: this.enabled, threshold: this.threshold });
    return this.status();
  }

  /** cswap accounts with real usage merged in from the usage reader, by email. */
  private async mergedAccounts(): Promise<{ activeAccountNumber: number | null; accounts: Account[] }> {
    const { activeAccountNumber, accounts } = await this.cswap.list();
    if (!this.usage.configured) return { activeAccountNumber, accounts };
    const byEmail = await this.usage.usageByEmail();
    const connected = new Set(this.usage.connectedEmails());
    const merged = accounts.map((a) => {
      const email = a.email.toLowerCase();
      const u = byEmail.get(email);
      if (u) return { ...a, usage: u, usageStatus: "ok", usageError: null };
      // Configured but not answering: say which, since "not tracked" and
      // "sign-in expired" call for opposite actions.
      const usageError = connected.has(email)
        ? (this.usage.errorFor(email) ?? "Usage unavailable right now.")
        : "Usage tracking not connected for this account.";
      return { ...a, usageError };
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
      this.onSwitched?.();
      this.lastSwitchAt = Date.now();
      logger.info("rate-limit switch", { active });
      return { switched: true, active };
    } catch (err) {
      logger.warn("rate-limit switch failed", { err: String(err) });
      return { switched: false, active: null };
    }
  }

  /**
   * Always runs the poll timer — even when rotation starts disabled — so
   * flipping it on from Settings takes effect on the next tick instead of
   * needing a daemon restart. `evaluate()` is a no-op while disabled.
   */
  start(): void {
    this.timer = setInterval(() => void this.tick(), this.config.rotation.pollMs);
    this.timer.unref();
    logger.info("account rotation timer started", { enabled: this.enabled, threshold: this.threshold });
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

  /**
   * Register a new coding account via `cswap add-token` (a `claude
   * setup-token` value, or a plain Anthropic API key). Diffs the account list
   * before/after to report which email got added, since cswap's own
   * add-token output format isn't guaranteed JSON. Never throws — errors come
   * back as `{ ok: false, message }` so the REST layer can pass them straight
   * through, and the raw token is never included in any log line here.
   */
  async addSetupToken(token: string): Promise<{ ok: boolean; email: string | null; message: string | null }> {
    const before = await this.cswap.list().catch(() => ({ activeAccountNumber: null, accounts: [] as Account[] }));
    try {
      await this.cswap.addToken(token);
    } catch (err) {
      return { ok: false, email: null, message: err instanceof Error ? err.message : "add-token failed" };
    }
    const after = await this.cswap.list().catch(() => ({ activeAccountNumber: null, accounts: [] as Account[] }));
    const beforeEmails = new Set(before.accounts.map((a) => a.email.toLowerCase()));
    const added = after.accounts.find((a) => !beforeEmails.has(a.email.toLowerCase()));
    logger.info("added coding account via setup-token", { email: added?.email ?? null });
    return { ok: true, email: added?.email ?? null, message: null };
  }

  /** Manual switch (REST). Honors the never-mid-flight rule too. */
  async manualSwitch(to?: number | string): Promise<SwitchAccountResponse> {
    if (this.anyBusy()) {
      return { ok: false, activeAccountNumber: null, message: "A session is mid-turn; try again in a moment." };
    }
    try {
      const active =
        to === undefined ? await this.cswap.switch(this.config.rotation.strategy) : await this.cswap.switchTo(to);
      this.onSwitched?.();
      this.lastSwitchAt = Date.now();
      logger.info("manual account switch", { active });
      return { ok: true, activeAccountNumber: active, message: null };
    } catch (err) {
      return { ok: false, activeAccountNumber: null, message: err instanceof Error ? err.message : "switch failed" };
    }
  }

  private status(): RotationStatus {
    return {
      enabled: this.enabled,
      threshold: this.threshold,
      cooldownMs: this.config.rotation.cooldownMs,
      lastSwitchAt: this.lastSwitchAt,
      lastHoldReason: this.lastHoldReason,
      preferredEmail: this.preferredEmail,
    };
  }

  /** Worst window across every limit an account reports — what the threshold is measured against. */
  private worstPct(account: Account): number {
    if (!account.usage) return 0;
    return Math.max(account.usage.fiveHour.pct, account.usage.sevenDay.pct);
  }

  /** Has this account got room to work under the current threshold? */
  private hasHeadroom(account: Account): boolean {
    return account.usageStatus === "ok" && !!account.usage && this.worstPct(account) < this.threshold;
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
    if (!this.enabled) return this.hold("disabled");
    const { cooldownMs, strategy } = this.config.rotation;
    const threshold = this.threshold;
    const { accounts } = await this.mergedAccounts();

    const active = accounts.find((a) => a.active);
    if (!active) return this.hold("no active account");

    /**
     * A preferred account is one you want to be on whenever it can work —
     * typically because the other login's quota is reserved for something
     * else (chatting on a phone, say). So as soon as it has headroom again we
     * come back to it, rather than drifting on the fallback until that one
     * fills up too.
     */
    const preferred = this.preferredEmail ? accounts.find((a) => a.email.toLowerCase() === this.preferredEmail) : undefined;
    if (preferred && !preferred.active && this.hasHeadroom(preferred)) {
      if (this.lastSwitchAt && Date.now() - this.lastSwitchAt < cooldownMs) return this.hold("cooldown");
      if (this.anyBusy()) return this.hold("session busy");
      await this.cswap.switchTo(preferred.number);
      this.onSwitched?.();
      this.lastSwitchAt = Date.now();
      this.lastHoldReason = null;
      logger.info("returned to the preferred account", { email: preferred.email, worstPct: this.worstPct(preferred) });
      return;
    }

    if (active.usageStatus !== "ok" || !active.usage) return this.hold("usage unavailable");

    const worst = this.worstPct(active);
    if (worst < threshold) return this.hold(null); // healthy — nothing to do

    // A switch only helps if another account actually has room.
    const alternatives = accounts.filter((a) => !a.active && this.hasHeadroom(a));
    if (alternatives.length === 0) return this.hold("all accounts at limit");

    if (this.lastSwitchAt && Date.now() - this.lastSwitchAt < cooldownMs) return this.hold("cooldown");

    // Never swap while a turn is live — defer to a later tick.
    if (this.anyBusy()) return this.hold("session busy");

    // With a preference set, the target must be a specific account — cswap's
    // own "best" strategy could otherwise pick the very account being
    // reserved. Without one, let cswap choose.
    const target = this.preferredEmail
      ? (alternatives.find((a) => a.email.toLowerCase() !== this.preferredEmail) ?? alternatives[0]!)
      : null;
    const newActive = target ? await this.cswap.switchTo(target.number) : await this.cswap.switch(strategy);
    this.onSwitched?.();
    this.lastSwitchAt = Date.now();
    this.lastHoldReason = null;
    logger.info("auto-rotated account", { from: active.number, to: newActive, worstPct: worst });
  }

  /**
   * Register a callback for after any switch lands. The daemon uses it to
   * recycle idle live `claude` processes, which may otherwise keep serving
   * requests with the previous account's credentials cached in memory.
   */
  setOnSwitched(fn: (() => void) | null): void {
    this.onSwitched = fn;
  }

  private hold(reason: string | null): void {
    this.lastHoldReason = reason;
  }

  private anyBusy(): boolean {
    return this.manager.listSessions().some((s) => s.status === "busy");
  }
}
