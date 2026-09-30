import type { EventPayload, InsightsResponse, StatsAchievement, StatsRecord, StatsSessionRef } from "@renki/protocol";
import { asc, inArray } from "drizzle-orm";
import { classifyRateLimit } from "../claude/runner.js";
import type { DB } from "../db/index.js";
import { compactions, events, presence, sessions } from "../db/schema.js";
import { RESTART_INTERRUPTED_MESSAGE, RESUME_CONTINUE_TEXT, restartContinueText } from "../sessions/manager.js";

/**
 * The Stats page's insights: everything beyond cost and tokens, worked out
 * from the whole event log in one pass. Nothing here is stored separately —
 * except who was connected (the presence table) and context compactions,
 * which the log doesn't otherwise see.
 *
 * The event kinds it reads; assistant_delta, the bulk of the log, is left out.
 */
const KINDS = [
  "turn_result",
  "prompt_submitted",
  "prompt_queued",
  "assistant_block",
  "tool_result",
  "permission_request",
  "permission_resolved",
  "background_task",
  "notice",
] as const;

type Payload<K extends EventPayload["kind"]> = Extract<EventPayload, { kind: K }>;

const DAY_MS = 86_400_000;
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const AGENT_TOOLS = new Set(["Task", "Agent"]);
/** Commands whose first word says little on its own: "git commit" reads better than "git". */
const TWO_WORD = new Set(["git", "npm", "pnpm", "yarn", "bun", "npx", "docker", "cargo", "go", "gh", "kubectl", "uv", "pip", "brew", "make", "turbo"]);
/** What Renki itself sends as a prompt (resuming, restarting): not something you wrote. */
const AUTO_PROMPTS = new Set([RESUME_CONTINUE_TEXT, restartContinueText(false), restartContinueText(true)]);

/** Local calendar parts of a moment, in one time zone. */
type LocalTime = { day: string; month: string; weekday: number; hour: number };

/**
 * Local time in `tz`, memoised per 15 minutes — Intl is slow enough to
 * matter over a hundred thousand events, and every zone's offset is a
 * multiple of 15 minutes.
 */
function localClock(tz: string): (ts: number) => LocalTime {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const weekdays: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const memo = new Map<number, LocalTime>();
  return (ts) => {
    const slot = Math.floor(ts / 900_000);
    let t = memo.get(slot);
    if (!t) {
      const p: Record<string, string> = {};
      for (const part of fmt.formatToParts(new Date(slot * 900_000))) p[part.type] = part.value;
      t = { day: `${p.year}-${p.month}-${p.day}`, month: `${p.year}-${p.month}`, weekday: weekdays[p.weekday!] ?? 0, hour: Number(p.hour) % 24 };
      memo.set(slot, t);
    }
    return t;
  };
}

/** A usable IANA zone name, or UTC. */
export function resolveTimeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
};

const wordCount = (s: string) => {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
};

const lineCount = (s: unknown) => (typeof s === "string" && s.length > 0 ? s.split("\n").length : 0);

/**
 * Lines one replacement adds and removes, ignoring lines it keeps at either
 * end — an Edit's old_string usually carries a few lines of context.
 */
export function replacementLines(before: unknown, after: unknown): { added: number; removed: number } {
  const a = typeof before === "string" && before ? before.split("\n") : [];
  const b = typeof after === "string" && after ? after.split("\n") : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { added: b.length - start - end, removed: a.length - start - end };
}

/** "git commit", "pnpm test", "ls": what kind of command this was, for the top-commands list. */
export function commandKind(command: string): string | null {
  // The last command of a chain is usually the point of it ("cd x && pnpm test").
  const segments = command.split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
  const meaningful = segments.filter((s) => !/^(cd|export|source|set)\b/.test(s));
  const segment = meaningful[meaningful.length - 1] ?? segments[segments.length - 1];
  if (!segment) return null;
  const words = segment.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (words[0] === "rtk" || words[0] === "sudo" || words[0] === "time") words.shift();
  let first = words[0];
  if (!first) return null;
  first = first.replace(/^.*\//, "");
  if (!TWO_WORD.has(first)) return first;
  // Skip options and their values ("git -C path status") to the subcommand.
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w === "-C" || w === "--filter" || w === "-F" || w === "--prefix" || w === "-w") {
      i++;
      continue;
    }
    if (w.startsWith("-")) continue;
    return `${first} ${w}`;
  }
  return first;
}

const GIT = (sub: string) => new RegExp(`\\bgit\\b(?:\\s+-C\\s+\\S+|\\s+-c\\s+\\S+)*\\s+${sub}\\b(?!-)`);
const GIT_COMMIT = GIT("commit");
const GIT_MERGE = GIT("merge");
const GIT_PUSH = GIT("push");

/** Consecutive-day runs over a set of "YYYY-MM-DD" days: the longest, and the one reaching today or yesterday. */
export function streaks(days: Iterable<string>, today: string): { current: number; longest: number; activeDays: number } {
  const nums = [...new Set(days)].map((d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY_MS).sort((a, b) => a - b);
  if (nums.length === 0) return { current: 0, longest: 0, activeDays: 0 };
  let longest = 1;
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    run = nums[i] === nums[i - 1]! + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const todayNum = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) / DAY_MS;
  const last = nums[nums.length - 1]!;
  return { current: todayNum - last <= 1 ? run : 0, longest, activeDays: nums.length };
}

/** How long ago `then` was, the way "remember when" puts it. */
function agoLabel(days: number): string {
  if (days >= 330) return days >= 690 ? `${Math.round(days / 365)} years ago` : "a year ago";
  const months = Math.round(days / 30.4);
  return months <= 1 ? "a month ago" : `${months} months ago`;
}

type Interval = { start: number; end: number };

/**
 * Total time the intervals in `a` spend inside `b`. `b` must be sorted and
 * non-overlapping; `a` may overlap itself (two sessions' turns at once each
 * count).
 */
export function overlapMs(a: Interval[], b: Interval[]): number {
  let total = 0;
  const sorted = [...a].sort((x, y) => x.start - y.start);
  let j = 0;
  for (const x of sorted) {
    while (j < b.length && b[j]!.end <= x.start) j++;
    for (let k = j; k < b.length && b[k]!.start < x.end; k++) total += Math.min(x.end, b[k]!.end) - Math.max(x.start, b[k]!.start);
  }
  return total;
}

export function computeInsights(db: DB, tzName: string | undefined, now = Date.now()): InsightsResponse {
  const tz = resolveTimeZone(tzName);
  const local = localClock(tz);

  const sessionRows = db
    .select({ id: sessions.id, title: sessions.title, repoName: sessions.repoName, status: sessions.status, worktreePath: sessions.worktreePath, createdAt: sessions.createdAt })
    .from(sessions)
    .all();
  const sessionById = new Map(sessionRows.map((s) => [s.id, s]));
  const ref = (sessionId: string): StatsSessionRef => {
    const s = sessionById.get(sessionId);
    return { sessionId, title: s?.title ?? null, repoName: s?.repoName ?? "Unknown repo", exists: !!s && s.status !== "deleted" };
  };
  const repoOf = (sessionId: string) => sessionById.get(sessionId)?.repoName ?? "Unknown repo";

  const rows = db
    .select({ sessionId: events.sessionId, ts: events.ts, kind: events.kind, data: events.data })
    .from(events)
    .where(inArray(events.kind, [...KINDS]))
    .orderBy(asc(events.ts))
    .all();

  // ── accumulators ──
  const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let longestTurn: StatsRecord | null = null;
  let mostExpensiveTurn: StatsRecord | null = null;
  const sessionTurnMs = new Map<string, { ms: number; ts: number }>();
  const activeDays = new Set<string>();
  const repoDays = new Map<string, Set<string>>();
  const turnsByDay = new Map<string, number>();
  const turnIntervals: Interval[] = [];
  const outcomes = { ok: 0, stopped: 0, limited: 0, restarted: 0, errored: 0 };
  const speed = new Map<string, { outputTokens: number; durationMs: number }>();
  const modelMonthly = new Map<string, Map<string, number>>();
  const cache = { inputTokens: 0, cachedInputTokens: 0 };
  let outputTokensTotal = 0;
  let nightTurn = false;
  let earlyTurn = false;
  let limitHits = 0;

  const promptLengths: number[] = [];
  let steered = 0;
  let queued = 0;
  let yourWords = 0;
  let claudesWords = 0;
  const firstPrompt = new Map<string, string>();

  type ToolUse = { sessionId: string; turnId: string; name: string; ts: number; input: Record<string, unknown> };
  const toolUses = new Map<string, ToolUse>();
  const failedTools = new Set<string>();
  const toolResultTs = new Map<string, number>();
  const backgroundDoneTs = new Map<string, number>();
  const toolsPerTurn = new Map<string, { count: number; sessionId: string; ts: number }>();

  const requests = new Map<string, { ts: number; toolName: string }>();
  const approvals = { count: 0, allowed: 0, denied: 0, unanswered: 0 };
  const responseMs: number[] = [];
  const byDevice = new Map<string, number[]>();
  const byTool = new Map<string, { allowed: number; denied: number }>();

  let pauses = 0;
  let pausedMs = 0;
  let resumedAfterPause = false;
  const pausedSince = new Map<string, number>();
  let switches = 0;
  const switchesTo = new Map<string, number>();

  for (const row of rows) {
    const e = JSON.parse(row.data) as EventPayload;
    const at = local(row.ts);

    switch (e.kind) {
      case "turn_result": {
        const durationMs = e.durationMs ?? 0;
        const start = row.ts - durationMs;
        const startAt = local(start);
        heatmap[startAt.weekday]![startAt.hour]! += 1;
        if (startAt.hour < 5) nightTurn = true;
        if (startAt.hour >= 5 && startAt.hour < 7) earlyTurn = true;
        activeDays.add(startAt.day);
        const repo = repoOf(row.sessionId);
        let days = repoDays.get(repo);
        if (!days) repoDays.set(repo, (days = new Set()));
        days.add(startAt.day);
        turnsByDay.set(startAt.day, (turnsByDay.get(startAt.day) ?? 0) + 1);
        if (durationMs > 0) turnIntervals.push({ start, end: row.ts });

        if (!longestTurn || durationMs > longestTurn.value) longestTurn = { value: durationMs, ts: row.ts, session: ref(row.sessionId) };
        if (e.costUsd != null && (!mostExpensiveTurn || e.costUsd > mostExpensiveTurn.value)) {
          mostExpensiveTurn = { value: e.costUsd, ts: row.ts, session: ref(row.sessionId) };
        }
        const s = sessionTurnMs.get(row.sessionId) ?? { ms: 0, ts: row.ts };
        s.ms += durationMs;
        s.ts = row.ts;
        sessionTurnMs.set(row.sessionId, s);

        if (e.ok) outcomes.ok++;
        else if (e.interrupted) outcomes.stopped++;
        else if (e.errorMessage === RESTART_INTERRUPTED_MESSAGE) outcomes.restarted++;
        else if (classifyRateLimit(e.errorMessage)) {
          outcomes.limited++;
          limitHits++;
        } else outcomes.errored++;

        const model = e.model ?? "default";
        const out = e.outputTokens ?? 0;
        outputTokensTotal += out;
        if (e.ok && out > 0 && durationMs > 0) {
          const sp = speed.get(model) ?? { outputTokens: 0, durationMs: 0 };
          sp.outputTokens += out;
          sp.durationMs += durationMs;
          speed.set(model, sp);
        }
        if (out > 0) {
          let m = modelMonthly.get(at.month);
          if (!m) modelMonthly.set(at.month, (m = new Map()));
          m.set(model, (m.get(model) ?? 0) + out);
        }
        if (e.cachedInputTokens != null) {
          cache.inputTokens += e.inputTokens ?? 0;
          cache.cachedInputTokens += e.cachedInputTokens;
        }
        break;
      }

      case "prompt_submitted": {
        if (AUTO_PROMPTS.has(e.text)) {
          // A pause or restart being picked back up.
          break;
        }
        promptLengths.push(e.text.length);
        yourWords += wordCount(e.text);
        if (e.steered) steered++;
        if (!firstPrompt.has(row.sessionId)) firstPrompt.set(row.sessionId, e.text);
        // You sent something yourself: whatever pause there was is over.
        const since = pausedSince.get(row.sessionId);
        if (since != null) {
          pausedMs += row.ts - since;
          pausedSince.delete(row.sessionId);
        }
        break;
      }

      case "prompt_queued":
        queued++;
        break;

      case "assistant_block": {
        if (e.blockKind === "text" && !e.parentToolUseId && e.text) claudesWords += wordCount(e.text);
        if (e.blockKind !== "tool_use" || !e.toolUseId || !e.toolName) break;
        const input = (e.toolInput && typeof e.toolInput === "object" ? e.toolInput : {}) as Record<string, unknown>;
        toolUses.set(e.toolUseId, { sessionId: row.sessionId, turnId: e.turnId, name: e.toolName, ts: row.ts, input });
        const key = `${row.sessionId}:${e.turnId}`;
        const t = toolsPerTurn.get(key) ?? { count: 0, sessionId: row.sessionId, ts: row.ts };
        t.count++;
        t.ts = row.ts;
        toolsPerTurn.set(key, t);
        break;
      }

      case "tool_result":
        if (!e.ok) failedTools.add(e.toolUseId);
        if (!toolResultTs.has(e.toolUseId)) toolResultTs.set(e.toolUseId, row.ts);
        break;

      case "background_task":
        if (e.toolUseId) backgroundDoneTs.set(e.toolUseId, row.ts);
        break;

      case "permission_request":
        // Questions are answered, not approved: they'd skew allow rates and response times.
        if (e.toolName !== "AskUserQuestion") requests.set(e.requestId, { ts: row.ts, toolName: e.toolName });
        break;

      case "permission_resolved": {
        const req = requests.get(e.requestId);
        if (!req) break;
        requests.delete(e.requestId);
        approvals.count++;
        if (!e.byDeviceId) {
          approvals.unanswered++;
          break;
        }
        const allowed = e.decision === "allow";
        if (allowed) approvals.allowed++;
        else approvals.denied++;
        const ms = row.ts - req.ts;
        responseMs.push(ms);
        const device = e.byDeviceId.split("_")[0] || "unknown";
        const list = byDevice.get(device) ?? [];
        list.push(ms);
        byDevice.set(device, list);
        const tool = byTool.get(req.toolName) ?? { allowed: 0, denied: 0 };
        if (allowed) tool.allowed++;
        else tool.denied++;
        byTool.set(req.toolName, tool);
        break;
      }

      case "notice": {
        const text = e.text;
        if (text.startsWith("Paused on a usage limit")) {
          if (!pausedSince.has(row.sessionId)) {
            pauses++;
            pausedSince.set(row.sessionId, row.ts);
          }
        } else if (
          text === "Usage limit reset — continuing." ||
          text === "Continuing now, as requested." ||
          text.startsWith("Automatic resume cancelled") ||
          text.startsWith("Still limited after")
        ) {
          const since = pausedSince.get(row.sessionId);
          if (since != null) {
            pausedMs += row.ts - since;
            pausedSince.delete(row.sessionId);
            if (text === "Usage limit reset — continuing.") resumedAfterPause = true;
          }
        } else {
          const sw = /^Switched account(?: \(now #(\d+)\))?/.exec(text);
          if (sw) {
            switches++;
            const to = sw[1] ? `#${sw[1]}` : "another";
            switchesTo.set(to, (switchesTo.get(to) ?? 0) + 1);
          }
        }
        break;
      }
    }
  }
  // Pauses still waiting count up to now.
  for (const since of pausedSince.values()) pausedMs += now - since;

  // ── tools, edits, agents, git ──
  const toolCounts = new Map<string, { count: number; failed: number }>();
  const shell = new Map<string, number>();
  const git = { commits: 0, merges: 0, pushes: 0 };
  const commitsByRepo = new Map<string, number>();
  const linesDaily = new Map<string, { added: number; removed: number }>();
  const files = new Map<string, { repoName: string; path: string; edits: number; added: number; removed: number }>();
  const filesPerSession = new Map<string, { files: Set<string>; ts: number }>();
  let agentCount = 0;
  let backgroundAgents = 0;
  const agentDurations: number[] = [];
  const agentTypes = new Map<string, number>();

  for (const [id, use] of toolUses) {
    const failed = failedTools.has(id);
    const tc = toolCounts.get(use.name) ?? { count: 0, failed: 0 };
    tc.count++;
    if (failed) tc.failed++;
    toolCounts.set(use.name, tc);

    if (use.name === "Bash" && typeof use.input.command === "string") {
      const kind = commandKind(use.input.command);
      if (kind) shell.set(kind, (shell.get(kind) ?? 0) + 1);
      if (!failed) {
        const cmd = use.input.command;
        if (GIT_COMMIT.test(cmd)) {
          git.commits++;
          const repo = repoOf(use.sessionId);
          commitsByRepo.set(repo, (commitsByRepo.get(repo) ?? 0) + 1);
        }
        if (GIT_MERGE.test(cmd)) git.merges++;
        if (GIT_PUSH.test(cmd)) git.pushes++;
      }
    }

    if (EDIT_TOOLS.has(use.name) && !failed) {
      const raw = (use.input.file_path ?? use.input.notebook_path) as unknown;
      if (typeof raw !== "string") continue;
      let added = 0;
      let removed = 0;
      if (use.name === "Edit") ({ added, removed } = replacementLines(use.input.old_string, use.input.new_string));
      else if (use.name === "MultiEdit" && Array.isArray(use.input.edits)) {
        for (const ed of use.input.edits as { old_string?: unknown; new_string?: unknown }[]) {
          const r = replacementLines(ed?.old_string, ed?.new_string);
          added += r.added;
          removed += r.removed;
        }
      } else if (use.name === "Write") added = lineCount(use.input.content);

      const day = local(use.ts).day;
      const d = linesDaily.get(day) ?? { added: 0, removed: 0 };
      d.added += added;
      d.removed += removed;
      linesDaily.set(day, d);

      const worktree = sessionById.get(use.sessionId)?.worktreePath;
      const path = worktree && raw.startsWith(`${worktree}/`) ? raw.slice(worktree.length + 1) : raw;
      const repoName = repoOf(use.sessionId);
      const fkey = `${repoName}\0${path}`;
      const f = files.get(fkey) ?? { repoName, path, edits: 0, added: 0, removed: 0 };
      f.edits++;
      f.added += added;
      f.removed += removed;
      files.set(fkey, f);

      const sf = filesPerSession.get(use.sessionId) ?? { files: new Set<string>(), ts: use.ts };
      sf.files.add(path);
      sf.ts = use.ts;
      filesPerSession.set(use.sessionId, sf);
    }

    if (AGENT_TOOLS.has(use.name)) {
      agentCount++;
      const bg = use.input.run_in_background === true;
      if (bg) backgroundAgents++;
      const type = typeof use.input.subagent_type === "string" && use.input.subagent_type ? use.input.subagent_type : "general-purpose";
      agentTypes.set(type, (agentTypes.get(type) ?? 0) + 1);
      const done = backgroundDoneTs.get(id) ?? (bg ? undefined : toolResultTs.get(id));
      if (done != null && done >= use.ts) agentDurations.push(done - use.ts);
    }
  }

  // ── hands-off time ──
  const presenceRows = db.select().from(presence).orderBy(asc(presence.ts)).all();
  const since = presenceRows[0]?.ts ?? null;
  // Nobody connected from each "nobody" row to the next "someone" row. Two
  // "nobody" rows in a row (a daemon restart) are one stretch.
  const offline: Interval[] = [];
  let offlineSince: number | null = null;
  for (const r of presenceRows) {
    if (!r.anyoneOnline) offlineSince ??= r.ts;
    else if (offlineSince != null) {
      offline.push({ start: offlineSince, end: r.ts });
      offlineSince = null;
    }
  }
  if (offlineSince != null) offline.push({ start: offlineSince, end: now });
  const trackedTurns = since == null ? [] : turnIntervals.filter((t) => t.end >= since).map((t) => ({ start: Math.max(t.start, since), end: t.end }));
  const handsOffMs = overlapMs(trackedTurns, offline);
  const trackedTurnMs = trackedTurns.reduce((s, t) => s + (t.end - t.start), 0);

  // ── most at once: a sweep over turn starts and ends ──
  let mostAtOnce: { count: number; ts: number } | null = null;
  {
    const points = turnIntervals.flatMap((t) => [{ ts: t.start, d: 1 }, { ts: t.end, d: -1 }]).sort((a, b) => a.ts - b.ts || a.d - b.d);
    let n = 0;
    for (const p of points) {
      n += p.d;
      if (!mostAtOnce || n > mostAtOnce.count) mostAtOnce = { count: n, ts: p.ts };
    }
  }

  // ── records ──
  let longestSession: StatsRecord | null = null;
  for (const [id, s] of sessionTurnMs) if (!longestSession || s.ms > longestSession.value) longestSession = { value: s.ms, ts: s.ts, session: ref(id) };
  let mostToolsInTurn: StatsRecord | null = null;
  for (const t of toolsPerTurn.values()) if (!mostToolsInTurn || t.count > mostToolsInTurn.value) mostToolsInTurn = { value: t.count, ts: t.ts, session: ref(t.sessionId) };
  let mostFilesInSession: StatsRecord | null = null;
  for (const [id, s] of filesPerSession) if (!mostFilesInSession || s.files.size > mostFilesInSession.value) mostFilesInSession = { value: s.files.size, ts: s.ts, session: ref(id) };
  let busiestDay: { day: string; turns: number } | null = null;
  for (const [day, turns] of turnsByDay) if (!busiestDay || turns > busiestDay.turns) busiestDay = { day, turns };

  // ── remember when: the session closest to a year, six, three or one month ago ──
  let rememberWhen: InsightsResponse["rememberWhen"] = null;
  for (const [daysAgo, slack] of [[365, 20], [180, 10], [90, 7], [30, 4]] as const) {
    const target = now - daysAgo * DAY_MS;
    let best: (typeof sessionRows)[number] | null = null;
    for (const s of sessionRows) {
      if (s.status === "deleted" || !firstPrompt.has(s.id)) continue;
      if (Math.abs(s.createdAt - target) > slack * DAY_MS) continue;
      if (!best || Math.abs(s.createdAt - target) < Math.abs(best.createdAt - target)) best = s;
    }
    if (best) {
      const prompt = firstPrompt.get(best.id) ?? null;
      rememberWhen = {
        session: ref(best.id),
        createdAt: best.createdAt,
        ago: agoLabel(Math.round((now - best.createdAt) / DAY_MS)),
        firstPrompt: prompt ? (prompt.length > 240 ? `${prompt.slice(0, 239)}…` : prompt) : null,
      };
      break;
    }
  }

  // ── streaks ──
  const today = local(now).day;
  const streak = streaks(activeDays, today);
  const repoStreaks = [...repoDays]
    .map(([repoName, days]) => ({ repoName, ...streaks(days, today) }))
    .sort((a, b) => b.current - a.current || b.longest - a.longest || b.activeDays - a.activeDays);

  // ── compactions ──
  const compactionRows = db.select().from(compactions).all();
  const preTokens = compactionRows.map((c) => c.preTokens).filter((n): n is number => n != null);

  const turnCount = outcomes.ok + outcomes.stopped + outcomes.limited + outcomes.restarted + outcomes.errored;
  const approvalsAnswered = approvals.allowed + approvals.denied;
  const achievements: StatsAchievement[] = [
    goal("first_turn", "Hello, Claude", "Ran your first turn", turnCount, 1),
    goal("turns_100", "Regular", "100 turns", turnCount, 100),
    goal("turns_1000", "Power user", "1,000 turns", turnCount, 1000),
    goal("streak_7", "A week straight", "Worked 7 days in a row", streak.longest, 7),
    goal("streak_30", "A month straight", "Worked 30 days in a row", streak.longest, 30),
    flag("night_owl", "Night owl", "Started a turn between midnight and 5am", nightTurn),
    flag("early_bird", "Early bird", "Started a turn between 5 and 7am", earlyTurn),
    goal("hands_off", "Walked away", "An hour of Claude working with no device connected", handsOffMs, 3_600_000),
    goal("multitasker", "Multitasker", "Three turns running at once", mostAtOnce?.count ?? 0, 3),
    goal("delegator", "Delegator", "Launched 25 agents", agentCount, 25),
    goal("approver", "Gatekeeper", "Answered 100 approvals", approvalsAnswered, 100),
    goal("committer", "Shipper", "100 commits made by Claude", git.commits, 100),
    goal("million", "Million tokens", "Claude wrote 1,000,000 output tokens", outputTokensTotal, 1_000_000),
    flag("comeback", "Comeback", "A turn continued by itself after a usage limit reset", resumedAfterPause),
  ];

  return {
    tz,
    computedAt: now,
    heatmap,
    longestTurn,
    longestSession,
    linesDaily: [...linesDaily].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    topFiles: [...files.values()].sort((a, b) => b.edits - a.edits || b.added + b.removed - (a.added + a.removed)).slice(0, 10),
    filesTouched: files.size,
    streak,
    repoStreaks: repoStreaks.slice(0, 8),
    prompts: { count: promptLengths.length, medianChars: median(promptLengths) ?? 0, steered, queued },
    tools: [...toolCounts].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count),
    shellCommands: top(shell, 10),
    agents: { count: agentCount, background: backgroundAgents, medianDurationMs: median(agentDurations), byType: top(agentTypes, 8) },
    handsOff: { since, handsOffMs, turnMs: trackedTurnMs },
    speed: [...speed].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.outputTokens - a.outputTokens),
    outcomes,
    approvals: {
      ...approvals,
      medianResponseMs: median(responseMs),
      byDevice: [...byDevice].map(([key, ms]) => ({ key, count: ms.length, medianResponseMs: median(ms) })).sort((a, b) => b.count - a.count),
      byTool: [...byTool].map(([tool, v]) => ({ tool, ...v })).sort((a, b) => b.allowed + b.denied - (a.allowed + a.denied)).slice(0, 8),
    },
    limits: { hits: limitHits, pauses, pausedMs, switches, switchesTo: top(switchesTo, 8) },
    cache,
    records: { mostExpensiveTurn, mostToolsInTurn, mostFilesInSession, busiestDay, mostAtOnce: mostAtOnce && mostAtOnce.count > 0 ? mostAtOnce : null },
    rememberWhen,
    words: { yours: yourWords, claudes: claudesWords },
    achievements,
    modelMonthly: [...modelMonthly].map(([month, m]) => ({ month, byModel: Object.fromEntries(m) })).sort((a, b) => a.month.localeCompare(b.month)),
    git: { ...git, byRepo: [...commitsByRepo].map(([repoName, commits]) => ({ repoName, commits })).sort((a, b) => b.commits - a.commits) },
    compactions: {
      count: compactionRows.length,
      auto: compactionRows.filter((c) => c.trigger === "auto").length,
      avgPreTokens: preTokens.length ? Math.round(preTokens.reduce((s, n) => s + n, 0) / preTokens.length) : null,
    },
  };
}

function top(map: Map<string, number>, n: number): { key: string; count: number }[] {
  return [...map].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count).slice(0, n);
}

function goal(id: string, title: string, description: string, value: number, target: number): StatsAchievement {
  return { id, title, description, achieved: value >= target, progress: value >= target ? null : Math.max(0, value / target) };
}

function flag(id: string, title: string, description: string, achieved: boolean): StatsAchievement {
  return { id, title, description, achieved, progress: null };
}

/**
 * computeInsights, remembered briefly per time zone: the page asks on every
 * open, and a scan of the whole log isn't free. Anything that appended since
 * is at most this stale.
 */
export class InsightsCache {
  private readonly entries = new Map<string, { at: number; value: InsightsResponse }>();
  constructor(
    private readonly db: DB,
    private readonly ttlMs = 60_000,
  ) {}

  get(tz: string | undefined): InsightsResponse {
    const zone = resolveTimeZone(tz);
    const hit = this.entries.get(zone);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const value = computeInsights(this.db, zone, now);
    this.entries.set(zone, { at: now, value });
    return value;
  }
}
