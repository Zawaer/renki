import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Strips repo-defined `hooks` out of a session's `.claude/settings.json` and
 * `.claude/settings.local.json` before every turn.
 *
 * Why: the Agent SDK loads project-level filesystem settings by default (so
 * CLAUDE.md and .mcp.json work), but that bundles in `hooks` too — and a
 * `PreToolUse`/`PostToolUse` command hook runs its shell command
 * unconditionally, even when `canUseTool` denies the corresponding tool call
 * (confirmed empirically against this SDK version). That means a repo's own
 * committed settings.json — from a malicious PR, a compromised dependency, or
 * Claude itself writing one mid-session under prompt injection — gets shell
 * execution with no approval prompt, defeating the whole point of routing
 * every gated tool call through a human controller.
 *
 * We can't ask the SDK to load CLAUDE.md/.mcp.json but not hooks —
 * `settingSources` gates entire files, not individual keys — so instead we
 * edit the files themselves in the session's own worktree (never the user's
 * source repo) right before each turn, removing just the `hooks` key and
 * leaving everything else (permissions, statusLine, etc.) intact.
 */
function stripHooksFromFile(path: string): void {
  if (!existsSync(path)) return;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON: we can't safely edit around just the `hooks` key, and
    // we can't assume the SDK's own parser is equally strict, so quarantine
    // the whole file rather than risk leaving a hook-bearing file in place.
    try {
      renameSync(path, `${path}.crc-quarantined`);
    } catch {
      // best-effort — nothing more we can do here
    }
    return;
  }

  if (!("hooks" in parsed)) return;
  delete parsed.hooks;
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

/** Call once per turn, before `query()` — see module doc for why per-turn, not just per-worktree-creation. */
export function stripUntrustedHooks(cwd: string): void {
  stripHooksFromFile(join(cwd, ".claude", "settings.json"));
  stripHooksFromFile(join(cwd, ".claude", "settings.local.json"));
}
