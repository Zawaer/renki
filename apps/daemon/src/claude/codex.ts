import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { logger } from "../logger.js";

/**
 * Codex (OpenAI's coding agent) as a tool Claude can hand work to: "have
 * Codex review this", "let Codex try the fix". Each call runs `codex exec`
 * once in the session's folder and returns Codex's final answer.
 *
 * Not `codex mcp-server`: the CLI dropped that mode (0.169 has none), and it
 * asked for approvals over MCP elicitation, which nothing here can answer.
 * Instead the hand-off itself is the approval: this tool goes through the
 * session's permission mode like any other, and Codex then runs without
 * asking, in the same container Claude's own Bash runs in, so it can reach
 * no more than Claude already can.
 *
 * Only offered when the CLI is installed and logged in (CODEX_HOME/auth.json),
 * so a session never sees a tool that can't work.
 */
export const CODEX_SERVER = "codex";
export const CODEX_TOOL = `mcp__${CODEX_SERVER}__run`;

/** Where the login lives: the data volume, so it survives redeploys (see Dockerfile). */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(process.env.HOME || "/root", ".codex");
}

const codexBin = () => process.env.RENKI_CODEX_BIN || "codex";

/** Installed and logged in: worth offering. Checked per session, so a login takes effect on the next one. */
export function codexAvailable(): boolean {
  return existsSync(join(codexHome(), "auth.json"));
}

/** A long Codex task still shouldn't hang a session forever. */
const CODEX_TIMEOUT_MS = 45 * 60_000;
/** What Claude gets back is Codex's answer, not a log: cap it so one call can't flood the context. */
const MAX_ANSWER_CHARS = 20_000;

export type CodexRunResult = { ok: boolean; text: string };

/**
 * One `codex exec` run. Exported for tests (with RENKI_CODEX_BIN pointing at
 * a stub). `--json` events give the thread id and token use; `-o` gives the
 * final message, which is the part worth returning.
 */
export function runCodex(args: { prompt: string; cwd: string; readOnly?: boolean; model?: string }, signal?: AbortSignal): Promise<CodexRunResult> {
  const before = args.readOnly ? changedFiles(args.cwd) : null;
  const prompt = args.readOnly ? `${READ_ONLY_BRIEF}\n\n${args.prompt}` : args.prompt;
  const dir = mkdtempSync(join(tmpdir(), "renki-codex-"));
  const out = join(dir, "last-message.txt");
  const argv = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-C",
    args.cwd,
    "-o",
    out,
    // The container is the sandbox: Codex's own (even read-only) needs kernel features Docker
    // doesn't give it, and failed every command with "sandbox error" (tried 2026-11-13), and
    // approvals can't be answered mid-run. Read-only is asked for in the brief and checked
    // afterwards instead (see changedFiles).
    "--dangerously-bypass-approvals-and-sandbox",
    ...(args.model ? ["-m", args.model] : []),
    "-",
  ];
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: CodexRunResult) => {
      if (settled) return;
      settled = true;
      if (before !== null) {
        const after = changedFiles(args.cwd);
        const touched = after === null ? [] : [...after].filter(([f, sig]) => before?.get(f) !== sig).map(([f]) => f);
        const gone = after === null ? [] : [...(before?.keys() ?? [])].filter((f) => !after.has(f));
        const all = [...touched, ...gone];
        if (all.length) r = { ...r, text: `${r.text}\n\nWarning: this was a read-only run, but Codex changed ${all.length} file${all.length === 1 ? "" : "s"}: ${all.slice(0, 20).join(", ")}${all.length > 20 ? ", …" : ""}. Check them with git diff.` };
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rmSync(dir, { recursive: true, force: true });
      resolve(r);
    };
    const child = spawn(codexBin(), argv, { cwd: args.cwd, env: { ...process.env, CODEX_HOME: codexHome() }, stdio: ["pipe", "pipe", "pipe"] });
    let threadId: string | null = null;
    let usage: { input_tokens?: number; output_tokens?: number } | null = null;
    let lastError: string | null = null;
    let buf = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const e = JSON.parse(line) as { type?: string; thread_id?: string; usage?: typeof usage; message?: string; error?: { message?: string } };
          if (e.type === "thread.started" && e.thread_id) threadId = e.thread_id;
          else if (e.type === "turn.completed" && e.usage) usage = e.usage;
          else if (e.type === "error" || e.type === "turn.failed") lastError = e.message ?? e.error?.message ?? lastError;
        } catch {
          // Not an event line; ignore.
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-4000);
    });
    child.on("error", (err) => finish({ ok: false, text: `Codex couldn't start: ${err.message}` }));
    child.on("close", (code) => {
      let answer = "";
      try {
        answer = readFileSync(out, "utf8").trim();
      } catch {
        // No final message: it failed before answering.
      }
      if (code === 0 && answer) {
        const clipped = answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS)}\n\n[…cut: Codex's answer was ${answer.length} characters]` : answer;
        const tokens = usage ? ` · ${usage.input_tokens ?? 0} tokens in, ${usage.output_tokens ?? 0} out` : "";
        return finish({ ok: true, text: `${clipped}\n\n(Codex run${threadId ? ` ${threadId}` : ""}${tokens})` });
      }
      const why = lastError ?? stderr.trim().split("\n").slice(-5).join("\n") ?? "";
      logger.warn("codex run failed", { code, why: why.slice(0, 500) });
      finish({ ok: false, text: `Codex failed${code != null ? ` (exit ${code})` : ""}${why ? `: ${why}` : "."}${answer ? `\n\nIts last message:\n${answer.slice(0, 4000)}` : ""}` });
    });
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    const timer = setTimeout(() => {
      kill();
      finish({ ok: false, text: `Codex was stopped after ${CODEX_TIMEOUT_MS / 60_000} minutes without finishing.` });
    }, CODEX_TIMEOUT_MS);
    timer.unref();
    const onAbort = () => {
      kill();
      finish({ ok: false, text: "Stopped." });
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.end(prompt);
  });
}

const READ_ONLY_BRIEF =
  "READ-ONLY TASK. Do not create, edit, move or delete any file, and do not run commands that change anything (no installs, no git commits, no formatters). Read, search and run read-only commands only, then answer.";

/**
 * Each changed or untracked file in the folder's git work tree, with a
 * signature of its state (status plus content hash), or null outside git. A
 * read-only run compares this before and after, to say plainly if Codex
 * changed something anyway.
 */
function changedFiles(cwd: string): Map<string, string> | null {
  try {
    const quiet = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
    // Paths come relative to the work tree's root, which a session's folder may be below.
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000, ...quiet }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, timeout: 20_000, ...quiet });
    const files = new Map<string, string>();
    const entries = status.split("\0").filter(Boolean);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const code = e.slice(0, 2);
      const file = e.slice(3);
      if (code.startsWith("R") || code.startsWith("C")) i++; // its original path follows
      let hash = "";
      try {
        hash = execFileSync("git", ["hash-object", "--", file], { cwd: root, timeout: 10_000, ...quiet }).trim();
      } catch {
        hash = "gone";
      }
      files.set(file, `${code}:${hash}`);
    }
    return files;
  } catch {
    return null;
  }
}

/** The session's Codex tool server: one tool, `run`. */
export function createCodexMcpServer(cwd: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: CODEX_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "run",
        "Hand a task to Codex, OpenAI's coding agent, in this session's folder, and get its final answer back. " +
          "Good for a second opinion (a review, a bug hunt, checking a plan) or letting it attempt a self-contained fix. " +
          "Codex starts with no context: write a complete brief (the goal, the files, what you've ruled out, what to report). " +
          "It can read and edit files and run commands here; with readOnly it's told not to, and any file it changes anyway is reported. Check its changes with git diff. " +
          "A run can take many minutes and blocks you meanwhile, so for anything long call it from a background agent.",
        {
          prompt: z.string().min(1).describe("The full brief for Codex."),
          readOnly: z.boolean().optional().describe("Tell Codex to only read and run read-only commands, and report any file it changes anyway. Use for reviews and questions."),
          model: z.string().optional().describe("A Codex model to use instead of its default. Leave unset unless the user asked for one."),
        },
        async (args, extra) => {
          const r = await runCodex({ prompt: args.prompt, cwd, readOnly: args.readOnly, model: args.model }, (extra as { signal?: AbortSignal } | undefined)?.signal);
          return { content: [{ type: "text" as const, text: r.text }], ...(r.ok ? {} : { isError: true }) };
        },
      ),
    ],
  });
}
