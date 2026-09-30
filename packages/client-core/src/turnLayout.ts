import type { Session } from "@renki/protocol";
import type { BlockView, TimelineItem, TurnView } from "./reducer.js";
import { type EditToolView, describeTool, parseEditView } from "./toolViews.js";

/**
 * How a turn's blocks are laid out on screen, shared by every client. DOM-free
 * for the same reason as the reducer: web, VS Code and the phone render the
 * same shapes.
 */

type ToolBlock = Extract<BlockView, { kind: "tool_use" }>;

/** One item in a turn as rendered: a single block, or a run of routine tool calls folded into one line. */
export type TurnSegment =
  | { kind: "block"; index: number; block: BlockView }
  | { kind: "group"; items: { index: number; block: BlockView }[]; summary: StepSummary };

/**
 * Tool calls that stay on their own line instead of folding into a group:
 * each is something to read (a plan, a task list, a question) or a unit of
 * work worth seeing by itself (an agent).
 */
const STANDALONE_TOOLS = new Set(["Agent", "Task", "TodoWrite", "ExitPlanMode", "AskUserQuestion"]);

function groupable(b: BlockView): boolean {
  if (b.kind === "thinking") return true;
  return b.kind === "tool_use" && !STANDALONE_TOOLS.has(b.toolName);
}

/**
 * Fold every run of two or more routine tool calls into one group — "Ran 3
 * commands, edited 2 files +40 −3" — the way a long agentic turn reads best:
 * what it did, not each call. Thinking between the calls folds in with them;
 * thinking at either end of a run stays outside, next to the text it leads to.
 *
 * `breakAfter` holds indices a run must not cross — where a steered prompt
 * renders, so it stays at the point Claude picked it up.
 */
export function groupTurnBlocks(blocks: BlockView[], breakAfter: ReadonlySet<number> = new Set()): TurnSegment[] {
  const out: TurnSegment[] = [];
  let run: { index: number; block: BlockView }[] = [];

  const flush = () => {
    let start = 0;
    let end = run.length;
    while (start < end && run[start]!.block.kind === "thinking") start++;
    while (end > start && run[end - 1]!.block.kind === "thinking") end--;
    const core = run.slice(start, end);
    const tools = core.filter((it) => it.block.kind === "tool_use").length;
    for (const it of run.slice(0, start)) out.push({ kind: "block", ...it });
    if (tools >= 2) out.push({ kind: "group", items: core, summary: summarizeSteps(core.map((it) => it.block)) });
    else for (const it of core) out.push({ kind: "block", ...it });
    for (const it of run.slice(end)) out.push({ kind: "block", ...it });
    run = [];
  };

  blocks.forEach((block, index) => {
    if (!block) return; // blocks are indexed by Claude's own numbering and can have holes
    if (groupable(block)) run.push({ index, block });
    else {
      flush();
      out.push({ kind: "block", index, block });
    }
    if (breakAfter.has(index)) flush();
  });
  flush();
  return out;
}

export type StepSummary = {
  /** "Ran 3 commands, edited 2 files, read 4 files". */
  text: string;
  added: number;
  removed: number;
  failed: number;
  running: boolean;
  /** While running, what the newest call is doing — shown beside the summary. */
  current: string | null;
};

type Category = "command" | "edit" | "write" | "read" | "search" | "fetch" | "websearch" | "other";

function categoryOf(toolName: string): Category {
  switch (toolName) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "command";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Write":
      return "write";
    case "Read":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
    case "WebFetch":
      return "fetch";
    case "WebSearch":
      return "websearch";
    default:
      return "other";
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function phrase(cat: Category, n: number): string {
  switch (cat) {
    case "command":
      return `ran ${plural(n, "command", "commands")}`;
    case "edit":
      return `edited ${plural(n, "file", "files")}`;
    case "write":
      return `wrote ${plural(n, "file", "files")}`;
    case "read":
      return `read ${plural(n, "file", "files")}`;
    case "search":
      return `ran ${plural(n, "search", "searches")}`;
    case "fetch":
      return `fetched ${plural(n, "page", "pages")}`;
    case "websearch":
      return `searched the web ${n === 1 ? "once" : `${n} times`}`;
    default:
      return `used ${plural(n, "tool", "tools")}`;
  }
}

function filePathOf(input: unknown): string | null {
  const inp = (input ?? {}) as Record<string, unknown>;
  const p = inp.file_path ?? inp.notebook_path;
  return typeof p === "string" ? p : null;
}

/** Lines added and removed by one edit. */
export function diffStat(view: EditToolView): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of view.hunks) for (const l of h.lines) {
    if (l.type === "add") added++;
    else if (l.type === "del") removed++;
  }
  return { added, removed };
}

/**
 * The one-line account of a run of tool calls, in order of first appearance.
 * File categories count distinct files, not calls — five edits to one file
 * is "edited 1 file".
 */
export function summarizeSteps(blocks: BlockView[]): StepSummary {
  const order: Category[] = [];
  const counts = new Map<Category, number>();
  const files = new Map<Category, Set<string>>();
  let added = 0;
  let removed = 0;
  let failed = 0;
  let running = false;
  let current: string | null = null;

  for (const b of blocks) {
    if (b.kind !== "tool_use") continue;
    const cat = categoryOf(b.toolName);
    if (!counts.has(cat)) order.push(cat);
    const path = filePathOf(b.toolInput);
    if ((cat === "edit" || cat === "write" || cat === "read") && path) {
      const set = files.get(cat) ?? new Set<string>();
      set.add(path);
      files.set(cat, set);
      counts.set(cat, set.size);
    } else counts.set(cat, (counts.get(cat) ?? 0) + 1);

    const view = parseEditView(b.toolName, b.toolInput);
    if (view) {
      const s = diffStat(view);
      added += s.added;
      removed += s.removed;
    }
    const outcome = b.backgroundTask?.status ?? (b.result ? (b.result.ok ? "ok" : "failed") : null);
    if (outcome === "failed") failed++;
    if (!b.result && !b.backgroundTask) {
      running = true;
      current = describeTool(b.toolName, b.toolInput).label;
    }
  }

  const parts = order.map((c) => phrase(c, counts.get(c) ?? 0));
  const text = parts.join(", ");
  return { text: text.charAt(0).toUpperCase() + text.slice(1), added, removed, failed, running, current };
}

export type FileChange = { filePath: string; added: number; removed: number; views: EditToolView[] };

/**
 * Every file a turn changed, with lines added and removed — the card at the
 * foot of a turn. Includes what its agents changed, since that's work the
 * turn is answerable for too. In the order the files were first touched.
 */
export function turnFileChanges(turn: TurnView): FileChange[] {
  const byPath = new Map<string, FileChange>();
  const walk = (blocks: BlockView[]) => {
    for (const b of blocks) {
      if (b?.kind !== "tool_use") continue;
      if (b.subagent) walk(b.subagent.blocks);
      if (b.result && !b.result.ok) continue; // a failed edit changed nothing
      const view = parseEditView(b.toolName, b.toolInput);
      const path = view?.filePath ?? filePathOf(b.toolInput);
      if (!view || !path) continue;
      const entry = byPath.get(path) ?? { filePath: path, added: 0, removed: 0, views: [] };
      const s = diffStat(view);
      entry.added += s.added;
      entry.removed += s.removed;
      entry.views.push(view);
      byPath.set(path, entry);
    }
  };
  walk(turn.blocks);
  return [...byPath.values()];
}

export type BackgroundTaskView = {
  toolUseId: string;
  kind: "agent" | "command";
  label: string;
  status: "running" | "completed" | "failed" | "stopped";
  summary: string | null;
};

/**
 * Everything the session sent off to run in the background — agents and
 * backgrounded commands, including ones its agents started — newest first.
 *
 * "running" means no outcome has arrived yet. A task whose process died with
 * a daemon restart never reports one, so it stays "running" here; the panel
 * says "no result yet" rather than promising it's alive.
 */
export function backgroundTasksOf(timeline: TimelineItem[]): BackgroundTaskView[] {
  const out: BackgroundTaskView[] = [];
  const walk = (blocks: BlockView[]) => {
    for (const b of blocks) {
      if (b?.kind !== "tool_use") continue;
      const inBackground = (b.toolInput as { run_in_background?: unknown } | null)?.run_in_background === true;
      if (inBackground || b.backgroundTask) out.push(taskView(b));
      if (b.subagent) walk(b.subagent.blocks);
    }
  };
  for (const item of timeline) if (item.type === "turn") walk(item.turn.blocks);
  return out.reverse();
}

function taskView(b: ToolBlock): BackgroundTaskView {
  return {
    toolUseId: b.toolUseId,
    kind: b.toolName === "Agent" || b.toolName === "Task" ? "agent" : "command",
    label: describeTool(b.toolName, b.toolInput).label,
    status: b.backgroundTask?.status ?? "running",
    summary: b.backgroundTask?.summary ?? null,
  };
}

export type AttentionReason = "permission" | "paused" | "error";

/**
 * Why a session needs you, if it does: waiting on an approval, paused on a
 * usage limit, or stopped on an error. Null for sessions that are fine — idle,
 * working, archived or in the trash.
 */
export function attentionReason(s: Session): AttentionReason | null {
  if (s.status === "archived" || s.status === "trashed" || s.status === "deleted") return null;
  if (s.hasPendingPermission) return "permission";
  if (s.resume && s.status !== "busy") return "paused";
  if (s.status === "error") return "error";
  return null;
}

/** Sessions needing you, most urgent first (approvals, then errors, then pauses), newest within each. */
export function sessionsNeedingAttention(sessions: Session[]): { session: Session; reason: AttentionReason }[] {
  const rank: Record<AttentionReason, number> = { permission: 0, error: 1, paused: 2 };
  return sessions
    .map((session) => ({ session, reason: attentionReason(session) }))
    .filter((x): x is { session: Session; reason: AttentionReason } => x.reason !== null)
    .sort((a, b) => rank[a.reason] - rank[b.reason] || b.session.lastActivityAt - a.session.lastActivityAt);
}

/** "just now", "12m ago", "3h ago", "2d ago" — for lists where the exact time doesn't matter. */
export function formatAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
