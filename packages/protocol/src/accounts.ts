import { z } from "zod";

/**
 * Multi-account usage rotation. The daemon automates the user's manual
 * `cswap --switch-account` habit: it reads per-account usage via cswap and,
 * when the active account nears its limit, tells cswap to swap which account's
 * credentials the official `claude` CLI loads on its NEXT startup. These DTOs
 * mirror cswap's `--json` output so the clients can render the same dashboard.
 *
 * Compliance: the daemon only ever asks cswap to change which account the
 * official CLI reads at startup — it never extracts or reuses a token itself.
 */

export const AccountUsageWindow = z.object({
  /** Percent of the window's quota consumed (0-100). */
  pct: z.number(),
  resetsAt: z.string().nullable(),
});
export type AccountUsageWindow = z.infer<typeof AccountUsageWindow>;

/**
 * Pay-as-you-go overage ("Extra usage" / usage credits) beyond the plan's
 * included 5h/7d limits. Only present once a plan has that enabled — most
 * accounts have neither `extra_usage` nor `spend` enabled on claude.ai's
 * usage response, in which case this is null and the UI hides it.
 */
export const AccountUsageExtra = z.object({
  pct: z.number(),
  usedDollars: z.number(),
  limitDollars: z.number(),
  currency: z.string(),
  /** claude.ai's own severity for the spend, same vocabulary as a limit window. */
  severity: z.string().default("normal"),
});
export type AccountUsageExtra = z.infer<typeof AccountUsageExtra>;

/**
 * One limit window claude.ai reports, straight from its `limits` array. A plan
 * has more than the two Renki used to model: the 5-hour session window, a weekly
 * cap across all models, AND a separate weekly cap per premium model (Opus,
 * Fable), each with its own reset. Any of them can be the one that blocks you,
 * so all of them are shown.
 */
export const AccountUsageLimit = z.object({
  /**
   * "session" (5-hour rolling), "weekly_all" (every model), "weekly_scoped"
   * (one model's own weekly allowance), or whatever else the API adds later.
   */
  kind: z.string(),
  /** What to call it: "Session usage", "All models", or the model's name. */
  label: z.string(),
  /** Only set for a scoped limit — the model it applies to, e.g. "Fable". */
  model: z.string().nullable(),
  pct: z.number(),
  resetsAt: z.string().nullable(),
  /** claude.ai's own severity: "normal" | "warning" | "critical" (unknown values render as normal). */
  severity: z.string(),
  /** True for the window currently being consumed — the 5-hour one while you work. */
  isActive: z.boolean(),
});
export type AccountUsageLimit = z.infer<typeof AccountUsageLimit>;

export const AccountUsage = z.object({
  fiveHour: AccountUsageWindow,
  sevenDay: AccountUsageWindow,
  /**
   * Every window the API reported, in its own order. Empty on older responses
   * that only carried five_hour/seven_day, in which case clients fall back to
   * the two fields above.
   */
  limits: z.array(AccountUsageLimit).default([]),
  extra: AccountUsageExtra.nullable(),
});
export type AccountUsage = z.infer<typeof AccountUsage>;

/**
 * One organization a session key can see, with its current usage. A claude.ai
 * account often has several (e.g. an empty personal org alongside the one that
 * carries the subscription), so the user picks which org's usage to track.
 */
export const UsageOrg = z.object({
  orgId: z.string(),
  name: z.string(),
  usage: AccountUsage.nullable(),
});
export type UsageOrg = z.infer<typeof UsageOrg>;

export const Account = z.object({
  number: z.number().int(),
  email: z.string(),
  active: z.boolean(),
  /** "ok" when usage is fresh; anything else (e.g. "unavailable") => hold. */
  usageStatus: z.string(),
  /**
   * Why usage is missing, as a sentence to show the user — null when it isn't
   * missing. "Not tracked" and "tracked but the sign-in expired" look identical
   * from the outside but need opposite actions, so the daemon says which.
   */
  usageError: z.string().nullable().default(null),
  usage: AccountUsage.nullable(),
});
export type Account = z.infer<typeof Account>;

export const RotationStatus = z.object({
  enabled: z.boolean(),
  /** Switch when the active account's 5h or 7d pct reaches this (0-100). */
  threshold: z.number(),
  cooldownMs: z.number().int(),
  lastSwitchAt: z.number().int().nullable(),
  /** Why the rotator last held off (e.g. "usage unavailable", "session busy"). */
  lastHoldReason: z.string().nullable(),
  /**
   * The account to run as whenever it has headroom, falling back to another
   * only while it's over the threshold and returning as soon as it resets.
   * Null means no preference: any account with headroom will do. Useful when
   * one login is for coding and another needs its quota kept free for
   * chatting elsewhere.
   */
  preferredEmail: z.string().nullable().default(null),
});
export type RotationStatus = z.infer<typeof RotationStatus>;

export const AccountsResponse = z.object({
  activeAccountNumber: z.number().int().nullable(),
  accounts: z.array(Account),
  rotation: RotationStatus,
  /** Whether any claude.ai usage session key is connected (drives the "Connected" pill). */
  usageConfigured: z.boolean().default(false),
  /** Emails we currently have a usage key for (lowercased). */
  usageConnectedEmails: z.array(z.string()).default([]),
});
export type AccountsResponse = z.infer<typeof AccountsResponse>;

/** Manual switch. Omit `to` for "pick the account with the most headroom". */
export const SwitchAccountRequest = z.object({
  to: z.union([z.number().int(), z.string()]).optional(),
});
export type SwitchAccountRequest = z.infer<typeof SwitchAccountRequest>;

export const SwitchAccountResponse = z.object({
  ok: z.boolean(),
  activeAccountNumber: z.number().int().nullable(),
  message: z.string().nullable(),
});
export type SwitchAccountResponse = z.infer<typeof SwitchAccountResponse>;

/** Update the rotation policy. Both fields optional — send only what changed. */
export const UpdateRotationRequest = z.object({
  enabled: z.boolean().optional(),
  threshold: z.number().min(1).max(100).optional(),
  /** An account's email to prefer, or null to clear the preference. Omit to leave it alone. */
  preferredEmail: z.string().nullable().optional(),
});
export type UpdateRotationRequest = z.infer<typeof UpdateRotationRequest>;

export const UpdateRotationResponse = z.object({
  ok: z.boolean(),
  rotation: RotationStatus,
  message: z.string().nullable(),
});
export type UpdateRotationResponse = z.infer<typeof UpdateRotationResponse>;

/**
 * Connect a claude.ai usage session key (`sk-ant-sid…`). Two-step by design so
 * the user — not a heuristic — chooses the org:
 *   1. POST with just `sessionKey` → daemon returns every `org` to pick from
 *      (`ok:false`, `orgs` populated, nothing persisted).
 *   2. POST with `sessionKey` + the chosen `orgId` → daemon persists it and
 *      reads usage back (`ok:true`).
 * `email` is an optional hint used only when claude.ai won't reveal the address.
 */
export const ConnectUsageKeyRequest = z.object({
  sessionKey: z.string().min(1),
  orgId: z.string().optional(),
  email: z.string().optional(),
});
export type ConnectUsageKeyRequest = z.infer<typeof ConnectUsageKeyRequest>;

export const ConnectUsageKeyResponse = z.object({
  ok: z.boolean(),
  /** The account the key belongs to (resolved from claude.ai, else the hint). */
  email: z.string().nullable(),
  orgId: z.string().nullable(),
  /** Fresh usage read back so the UI can confirm the connection works. */
  usage: AccountUsage.nullable(),
  /** When no `orgId` was chosen yet, the orgs to pick from (`ok:false`). */
  orgs: z.array(UsageOrg).default([]),
  message: z.string().nullable(),
});
export type ConnectUsageKeyResponse = z.infer<typeof ConnectUsageKeyResponse>;

/** Remove a previously-connected claude.ai usage key (e.g. wrong org picked). */
export const DisconnectUsageKeyResponse = z.object({
  ok: z.boolean(),
});
export type DisconnectUsageKeyResponse = z.infer<typeof DisconnectUsageKeyResponse>;

/**
 * Guided browser login: the daemon opens a real browser (Playwright) on its
 * own host at claude.ai, the user signs in, and the daemon reads the
 * resulting session cookie. `unavailable` distinguishes "Playwright/Chrome
 * isn't installed (or there's no display) on the host" (a setup problem) from
 * an ordinary failure/timeout.
 */
export const UsageLoginResponse = z.object({
  ok: z.boolean(),
  email: z.string().nullable(),
  usage: AccountUsage.nullable(),
  /** Orgs to pick from after a successful login. */
  orgs: z.array(UsageOrg).default([]),
  /**
   * The extracted session key, returned so the (trusted, tailnet-local) web
   * client can complete the org pick with a follow-up connect call. Null on
   * failure / when Playwright is unavailable.
   */
  sessionKey: z.string().nullable().default(null),
  message: z.string().nullable(),
  unavailable: z.boolean().default(false),
});
export type UsageLoginResponse = z.infer<typeof UsageLoginResponse>;

/**
 * Register a brand-new coding account — the credential `cswap` rotates the
 * official `claude` CLI across — from a `claude setup-token` value (or a
 * plain Anthropic Console API key). Distinct from `ConnectUsageKeyRequest`,
 * which only ever connects a read-only claude.ai usage session key.
 */
export const AddSetupTokenRequest = z.object({
  token: z.string().min(1),
});
export type AddSetupTokenRequest = z.infer<typeof AddSetupTokenRequest>;

export const AddSetupTokenResponse = z.object({
  ok: z.boolean(),
  /** The newly added account's email, when cswap's post-add listing let us diff it out. */
  email: z.string().nullable(),
  message: z.string().nullable(),
});
export type AddSetupTokenResponse = z.infer<typeof AddSetupTokenResponse>;
