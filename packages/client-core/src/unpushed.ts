import type { Session } from "@renki/protocol";
import { EFFORT_LEVELS } from "./effort.js";
import type { PermissionModeKey } from "./permissionMode.js";

type Unpushed = NonNullable<Session["unpushed"]>;

/** "3 commits not on GitHub", "2 uncommitted files", or both, for the banner above the composer. */
export function unpushedSummary(u: Unpushed): string {
  const parts: string[] = [];
  if (u.commits > 0) parts.push(`${u.commits} commit${u.commits === 1 ? "" : "s"} not on GitHub`);
  if (u.changedFiles > 0) parts.push(`${u.changedFiles} uncommitted file${u.changedFiles === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** The sidebar row's badge: "↑3" for commits, "•" when only files are uncommitted. */
export function unpushedBadge(u: Unpushed | null | undefined): string | null {
  if (!u) return null;
  if (u.commits > 0) return `↑${u.commits}`;
  return u.changedFiles > 0 ? "•" : null;
}

/** What the Push button sends Claude. Claude does the push, so it can merge with whatever changed on main first. */
export const PUSH_PROMPT =
  "Push this chat's work to main on GitHub. Commit anything uncommitted first. If main has moved on, rebase onto it and resolve any conflicts, then push and tell me what went up.";

/** The session's own composer settings, as submitPrompt takes them, for a prompt sent by a button. */
export function promptOptsFor(composer: Session["composer"] | null | undefined) {
  const effort = EFFORT_LEVELS.find((e) => e.key === composer?.effortKey);
  return {
    ...(composer?.model ? { model: composer.model } : {}),
    ...(effort ? { maxThinkingTokens: effort.maxThinkingTokens } : {}),
    ...(composer?.permissionMode ? { permissionMode: composer.permissionMode as PermissionModeKey } : {}),
  };
}
