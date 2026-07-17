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

export const AccountUsage = z.object({
  fiveHour: AccountUsageWindow,
  sevenDay: AccountUsageWindow,
});
export type AccountUsage = z.infer<typeof AccountUsage>;

export const Account = z.object({
  number: z.number().int(),
  email: z.string(),
  active: z.boolean(),
  /** "ok" when usage is fresh; anything else (e.g. "unavailable") => hold. */
  usageStatus: z.string(),
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
});
export type RotationStatus = z.infer<typeof RotationStatus>;

export const AccountsResponse = z.object({
  activeAccountNumber: z.number().int().nullable(),
  accounts: z.array(Account),
  rotation: RotationStatus,
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
