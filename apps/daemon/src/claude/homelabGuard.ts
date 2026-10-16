import { basename } from "node:path";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

/**
 * Per-project switch for the `homelab` command (docs/homelab-gateway.md).
 *
 * RENKI_HOMELAB_REPOS lists the repos whose sessions may operate the homelab.
 * Unset = not enforced (everything allowed, as before). Set = only those repos;
 * an empty value means nobody. `@plain` stands for repo-less sessions.
 *
 * Be clear about what this is: a guardrail against accidents and the lazy kind of
 * prompt injection ("now run homelab deploy …"). Sessions share one container and
 * one user, so a session set on getting around it can — the gateway's own tiers,
 * policy and phone approval are what actually limit the damage. The value comes
 * from the daemon's own environment, which sessions cannot edit.
 */

export function parseHomelabRepos(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function homelabAllowed(allowed: string[] | null | undefined, repoId: string | null, repoName: string): boolean {
  if (allowed == null) return true; // not enforced (unset)
  if (!repoId) return allowed.includes("@plain");
  return allowed.includes(repoId.toLowerCase()) || allowed.includes(repoName.toLowerCase());
}

const VERBS = "status|logs|top|deploy|restart|builder-prune|caddy-reload|backup-audit|job|rm-path|remove-container";
const PREFIX_WORDS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice", "stdbuf", "timeout", "xargs", "builtin"]);

/** Why this Bash command would reach the gateway, or null if it wouldn't. */
export function homelabCommandReason(command: string): string | null {
  // Anything naming the gateway's own plumbing is a bypass attempt, in any quoting.
  if (/\/gateway\/|renki_key|homelab-gw|homelab-host|\/usr\/local\/bin\/homelab/.test(command)) {
    return "it refers to the homelab gateway's key or address";
  }
  // `homelab …` in command position: the start, or after ; && || | ( { ` $( or a newline.
  for (const segment of command.split(/&&|\|\||[;|&\n(){}`]|\$\(/)) {
    const words = segment.trim().split(/\s+/);
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || PREFIX_WORDS.has(words[i]!) || words[i]!.startsWith("-"))) i++;
    const first = words[i];
    if (first && basename(first.replace(/^["']|["']$/g, "")) === "homelab") return "it runs the homelab command";
  }
  // Inside a quoted string, e.g. bash -c "homelab deploy x": only when a real verb follows.
  if (new RegExp(`["'\`]\\s*(?:sudo\\s+)?homelab\\s+(?:${VERBS})\\b`).test(command)) return "it runs the homelab command";
  return null;
}

const DENY_MESSAGE =
  "This project doesn't have homelab access, so the `homelab` command is off here. " +
  "Don't look for another way to reach the homelab. Tell the user what you wanted to do and why; " +
  "they can enable it for this project (RENKI_HOMELAB_REPOS) if they want.";

export function createHomelabGuardHook(): HookCallbackMatcher {
  return {
    matcher: "Bash",
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return { continue: true };
        const command = (input.tool_input as { command?: unknown } | null)?.command;
        if (typeof command !== "string" || homelabCommandReason(command) === null) return { continue: true };
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: DENY_MESSAGE,
          },
        };
      },
    ],
  };
}
