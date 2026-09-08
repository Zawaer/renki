/**
 * Pure parsers that turn a few well-known tools' raw `toolInput` (untyped —
 * it comes straight off the SDK's tool_use block) into shapes the clients can
 * render specially (a diff, a checklist, a plan) instead of falling back to
 * raw JSON. DOM-free on purpose, same reason as reducer.ts: shared by React
 * (web/VS Code) and React Native (mobile).
 */

export type DiffLineView = { type: "context" | "add" | "del"; text: string };
export type EditHunkView = { lines: DiffLineView[] };
export type EditToolView = { filePath: string | null; hunks: EditHunkView[] };

export type TodoItemView = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
};

/** Above this many (oldLines × newLines) cells, skip line-matching and just show a straight replace — O(n·m) DP isn't worth it for a full-file Write. */
const MAX_DIFF_CELLS = 250_000;

/** Classic LCS-based line diff. */
export function diffLines(oldText: string, newText: string): DiffLineView[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_DIFF_CELLS) {
    return [
      ...a.map((text): DiffLineView => ({ type: "del", text })),
      ...b.map((text): DiffLineView => ({ type: "add", text })),
    ];
  }

  // dp[i][j] rows are always fully populated ((n+1)x(m+1)) and every access
  // below stays within i in [0, n], j in [0, m] by construction — safe to
  // assert non-null rather than thread `?? 0` through every read.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const result: DiffLineView[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "context", text: a[i] ?? "" });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      result.push({ type: "del", text: a[i] ?? "" });
      i++;
    } else {
      result.push({ type: "add", text: b[j] ?? "" });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "del", text: a[i] ?? "" });
    i++;
  }
  while (j < m) {
    result.push({ type: "add", text: b[j] ?? "" });
    j++;
  }
  return result;
}

/** Edit/MultiEdit/Write → a diff view, or null if the input doesn't match the expected shape. */
export function parseEditView(toolName: string, toolInput: unknown): EditToolView | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const input = toolInput as Record<string, unknown>;
  const filePath = typeof input.file_path === "string" ? input.file_path : null;

  if (toolName === "Edit") {
    const oldString = input.old_string;
    const newString = input.new_string;
    if (typeof oldString !== "string" || typeof newString !== "string") return null;
    return { filePath, hunks: [{ lines: diffLines(oldString, newString) }] };
  }

  if (toolName === "MultiEdit") {
    const edits = input.edits;
    if (!Array.isArray(edits) || edits.length === 0) return null;
    const hunks: EditHunkView[] = [];
    for (const e of edits) {
      if (!e || typeof e !== "object") return null;
      const oldString = (e as Record<string, unknown>).old_string;
      const newString = (e as Record<string, unknown>).new_string;
      if (typeof oldString !== "string" || typeof newString !== "string") return null;
      hunks.push({ lines: diffLines(oldString, newString) });
    }
    return { filePath, hunks };
  }

  if (toolName === "Write") {
    const content = input.content;
    if (typeof content !== "string") return null;
    return { filePath, hunks: [{ lines: diffLines("", content) }] };
  }

  return null;
}

/** TodoWrite → the todo list, or null if the input doesn't match the expected shape. */
export function parseTodos(toolInput: unknown): TodoItemView[] | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const todos = (toolInput as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) return null;

  const result: TodoItemView[] = [];
  for (const t of todos) {
    if (!t || typeof t !== "object") return null;
    const content = (t as Record<string, unknown>).content;
    const status = (t as Record<string, unknown>).status;
    if (typeof content !== "string" || (status !== "pending" && status !== "in_progress" && status !== "completed")) {
      return null;
    }
    const activeForm = (t as Record<string, unknown>).activeForm;
    result.push({ content, status, activeForm: typeof activeForm === "string" ? activeForm : undefined });
  }
  return result;
}

export type AskUserQuestionOptionView = { label: string; description: string; preview?: string };
export type AskUserQuestionQuestionView = {
  question: string;
  header: string;
  options: AskUserQuestionOptionView[];
  multiSelect: boolean;
};
export type AskUserQuestionView = { questions: AskUserQuestionQuestionView[] };

/**
 * AskUserQuestion → its questions/options, or null if the input doesn't match.
 * Per the tool's own contract, models never include an "Other" option
 * themselves ("that will be provided automatically") — callers render one.
 */
export function parseAskUserQuestion(toolName: string, toolInput: unknown): AskUserQuestionView | null {
  if (toolName !== "AskUserQuestion") return null;
  if (!toolInput || typeof toolInput !== "object") return null;
  const questions = (toolInput as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const result: AskUserQuestionQuestionView[] = [];
  for (const q of questions) {
    if (!q || typeof q !== "object") return null;
    const question = (q as Record<string, unknown>).question;
    const header = (q as Record<string, unknown>).header;
    const options = (q as Record<string, unknown>).options;
    const multiSelect = (q as Record<string, unknown>).multiSelect;
    if (typeof question !== "string" || typeof header !== "string" || !Array.isArray(options) || options.length === 0) {
      return null;
    }

    const parsedOptions: AskUserQuestionOptionView[] = [];
    for (const o of options) {
      if (!o || typeof o !== "object") return null;
      const label = (o as Record<string, unknown>).label;
      const description = (o as Record<string, unknown>).description;
      const preview = (o as Record<string, unknown>).preview;
      if (typeof label !== "string" || typeof description !== "string") return null;
      parsedOptions.push({ label, description, preview: typeof preview === "string" ? preview : undefined });
    }
    result.push({ question, header, options: parsedOptions, multiSelect: multiSelect === true });
  }
  return { questions: result };
}

/** ExitPlanMode → the plan markdown, or null for any other tool. */
export function parsePlan(toolName: string, toolInput: unknown): string | null {
  if (toolName !== "ExitPlanMode") return null;
  if (!toolInput || typeof toolInput !== "object") return null;
  const plan = (toolInput as Record<string, unknown>).plan;
  return typeof plan === "string" ? plan : null;
}

/** What a tool call is, in words: a row label plus the mono detail beside it. */
export type ToolDescription = { label: string; meta: string | null };

function truncateMeta(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Turn a tool call into a sentence a person can skim: "Edited manager.ts",
 * "Searched the web", or the model's own one-line Bash description.
 *
 * Shared by web and mobile because it's the transcript's vocabulary, not a
 * layout detail — the phone used to print the tool's raw name over a dump of
 * its JSON input, which is the same call described in a different language.
 */
export function describeTool(name: string, input: unknown): ToolDescription {
  const inp = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof inp[k] === "string" ? (inp[k] as string) : null);
  /** Last two path segments — enough to recognise a file without the whole tree. */
  const base = (path: string | null) => (path ? path.split("/").filter(Boolean).slice(-2).join("/") : null);
  switch (name) {
    case "Bash": {
      // The model's own one-line description IS the sentence worth showing;
      // only fall back to the command when it didn't write one.
      const described = str("description");
      return described ? { label: described, meta: null } : { label: "Ran a command", meta: truncateMeta(str("command") ?? "", 72) };
    }
    case "BashOutput":
      return { label: "Checked command output", meta: null };
    case "Read":
      return { label: "Read", meta: base(str("file_path")) };
    case "Write":
      return { label: "Wrote", meta: base(str("file_path")) };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { label: "Edited", meta: base(str("file_path") ?? str("notebook_path")) };
    case "Grep":
    case "Glob":
      return { label: "Searched", meta: str("pattern") };
    case "WebFetch":
      return { label: "Fetched", meta: hostOf(str("url")) };
    case "WebSearch":
      return { label: "Searched the web", meta: str("query") };
    case "Agent":
    case "Task": {
      const described = str("description");
      return described ? { label: described, meta: null } : { label: "Agent", meta: str("subagent_type") };
    }
    case "TodoWrite":
      return { label: "Updated tasks", meta: null };
    case "AskUserQuestion":
      return { label: "Asked a question", meta: null };
    case "ExitPlanMode":
      return { label: "Proposed a plan", meta: null };
    default:
      return { label: name, meta: null };
  }
}
