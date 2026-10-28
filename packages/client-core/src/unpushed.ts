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

/** "3 commits behind main", for the banner that offers to pull them in. */
export function behindSummary(commits: number, base: string | null): string {
  return `${commits} commit${commits === 1 ? "" : "s"} behind ${base ?? "main"}`;
}

/** What the Pull button sends Claude, so it can resolve conflicts with the branch's own commits on the way. */
export const PULL_PROMPT =
  "Bring this branch up to date with main on GitHub. Fetch, then rebase onto origin/main (or merge, if this branch is already on GitHub) and resolve any conflicts. Don't push. Tell me what came in.";

/** The session's own composer settings, as submitPrompt takes them, for a prompt sent by a button. */
export function promptOptsFor(composer: Session["composer"] | null | undefined) {
  const effort = EFFORT_LEVELS.find((e) => e.key === composer?.effortKey);
  return {
    ...(composer?.model ? { model: composer.model } : {}),
    ...(effort ? { maxThinkingTokens: effort.maxThinkingTokens } : {}),
    ...(composer?.permissionMode ? { permissionMode: composer.permissionMode as PermissionModeKey } : {}),
  };
}
