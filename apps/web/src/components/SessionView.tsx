import {
  classifyAttachment,
  EFFORT_LEVELS,
  estimateTokens,
  formatCost,
  formatTokenCount,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_PROMPT,
  parseAskUserQuestion,
  parseEditView,
  parsePlan,
  parseTodos,
  PERMISSION_MODES,
  THINKING_VERBS,
  displayBranch,
  turnTriggerLabel,
  type AskUserQuestionView,
  type Attachment,
  type BlockView,
  type ContextUsageView,
  type EditToolView,
  type PermissionModeKey,
  type PermissionView,
  type SteeredPromptView,
  type SubagentView,
  type TimelineItem,
  type TodoItemView,
  type TurnView,
} from "@crc/client-core";
import type { CapabilitiesResponse } from "@crc/protocol";
import { useEffect, useRef, useState, Fragment } from "react";
import { useClient, useStoreValue } from "../lib/client.js";
import { hostOpenFile, isHosted } from "../lib/host.js";
import {
  loadEffortKey,
  loadModel,
  loadPermissionMode,
  saveEffortKey,
  saveModel,
  savePermissionMode,
} from "../lib/composerPrefs.js";
import { JsonCode, ShellCode } from "./Code.js";
import { Markdown } from "./Markdown.js";
import { Button, CopyButton, Skeleton, StatusBadge } from "./ui.js";

export function SessionView({ sessionId }: { sessionId: string }) {
  const { realtime, config } = useClient();
  const store = realtime.conversation(sessionId);
  const conv = useStoreValue(store);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Subscribe on mount / when the selected session changes. client-core handles
  // replay + live; we just declare interest.
  useEffect(() => {
    realtime.watch(sessionId);
    return () => realtime.unwatch(sessionId);
  }, [realtime, sessionId]);

  /**
   * Follow the newest output ONLY while the reader is already at the bottom.
   * Scrolling up is a deliberate act — reading something further back — and a
   * streaming reply that yanks you forward makes the transcript unusable. The
   * threshold absorbs sub-pixel rounding, nothing more.
   */
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  function onTranscriptScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
    stickToBottom.current = stick;
    setAtBottom((was) => (was === stick ? was : stick));
  }

  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  // Opening a different session always starts at its newest output.
  useEffect(() => {
    stickToBottom.current = true;
    setAtBottom(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [sessionId]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [conv]);

  const isController = conv.controller === config.deviceId;
  const status = conv.status ?? "idle";

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-6 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="truncate text-[15px] font-medium tracking-tight text-(--crc-fg)">
              {conv.repoName ?? "…"}
            </span>
            <StatusBadge
              status={status}
              pendingPermission={conv.pending.length > 0}
            />
          </div>
          {displayBranch(conv.branch) && (
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-(--crc-fg-muted)">
              <span className="codicon codicon-git-branch text-[11px]" />
              <span className="truncate font-mono">
                {displayBranch(conv.branch)}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {conv.context && <ContextMeter context={conv.context} />}
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-medium ${
              conv.controller && isController
                ? "text-(--crc-success)"
                : "text-(--crc-fg-muted)"
            }`}
          >
            <span
              className={`codicon ${conv.controller && isController ? "codicon-verified" : conv.controller ? "codicon-eye" : "codicon-unlock"} text-[13px]`}
            />
            {conv.controller
              ? isController
                ? "You're in control"
                : `${conv.controllerName ?? conv.controller} is in control — you're watching`
              : "Nobody is in control"}
          </span>
          {!isController && (
            <Button
              variant="primary"
              onClick={() => realtime.takeControl(sessionId)}
            >
              Take control
            </Button>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div ref={scrollRef} onScroll={onTranscriptScroll} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-7 px-6 py-6">
          {conv.status === null && conv.timeline.length === 0 && (
            <div className="space-y-7" aria-busy="true" aria-label="Loading conversation">
              <div className="flex justify-end">
                <Skeleton className="h-16 w-[60%] rounded-2xl" />
              </div>
              <div className="space-y-3">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-3.5 w-[92%]" />
                <Skeleton className="h-3.5 w-[78%]" />
                <Skeleton className="h-3.5 w-[85%]" />
                <Skeleton className="mt-4 h-3 w-56" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          )}
          {conv.status !== null && conv.timeline.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-24 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-(--crc-surface) text-(--crc-fg-muted) shadow-(--crc-shadow-sm)">
                <span className="codicon codicon-sparkle text-xl" />
              </span>
              <div>
                <div className="text-sm font-medium text-(--crc-fg)">
                  Nothing here yet
                </div>
                <div className="mt-1 text-xs text-(--crc-fg-muted)">
                  {isController
                    ? "Send a prompt below to get Claude going."
                    : "Take control and send a prompt to get Claude going."}
                </div>
              </div>
            </div>
          )}
          {conv.timeline.map((item, i) => (
            <TimelineRow key={i} item={item} />
          ))}
        </div>
        {!atBottom && conv.timeline.length > 0 && (
          <div className="pointer-events-none sticky bottom-4 flex h-0 items-end justify-center">
            <button
              onClick={jumpToLatest}
              className="crc-enter pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-(--crc-surface) px-3 py-1.5 text-xs font-medium text-(--crc-fg) shadow-(--crc-shadow-md) transition-colors hover:bg-(--crc-hover)"
            >
              {status === "busy" ? (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-(--crc-warning) animate-pulse" />
                  Claude is writing
                </>
              ) : (
                <span className="codicon codicon-arrow-down text-[12px]" />
              )}
              {status === "busy" ? <span className="codicon codicon-arrow-down text-[12px]" /> : "Jump to latest"}
            </button>
          </div>
        )}
      </div>

      {/* Pending permissions */}
      {conv.pending.length > 0 && (
        <div className="px-6 pb-3">
          <div className="mx-auto w-full max-w-3xl space-y-2">
            {conv.pending.map((p) => (
              <PermissionCard
                key={p.requestId}
                perm={p}
                canAct={isController}
                onDecide={(d, updatedInput) =>
                  realtime.resolvePermission(
                    sessionId,
                    p.requestId,
                    d,
                    updatedInput,
                  )
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* Queued prompts — kept out of the timeline itself so a fast follow-up
          can't render ahead of the turn it's replying to (see client-core's
          QueuedPromptView). Shown here as "up next", separate from the
          strictly-ordered conversation above. */}
      {conv.queuedPrompts.length > 0 && (
        <div className="px-6 pb-2">
          <div className="mx-auto w-full max-w-3xl space-y-1">
            <div className="text-[11px] text-(--crc-fg-muted)">
              {conv.queuedPrompts.length === 1
                ? "1 message queued"
                : `${conv.queuedPrompts.length} messages queued`}{" "}
              — will send once the current turn finishes
            </div>
            {conv.queuedPrompts.map((q) => (
              <div
                key={q.promptId}
                className="flex items-center gap-1.5 truncate text-xs text-(--crc-fg-muted)"
              >
                <span className="codicon codicon-history shrink-0" />
                <span className="truncate">{q.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Composer
        sessionId={sessionId}
        disabled={!isController}
        reason={!isController ? "Take control to send prompts" : ""}
        onSend={(text, opts) => realtime.submitPrompt(sessionId, text, opts)}
        busy={isController && status === "busy"}
        onStop={() => realtime.interrupt(sessionId)}
      />
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  if (item.type === "prompt") {
    return (
      <div className="crc-enter group flex items-center justify-end gap-1">
        {item.text && <CopyButton text={item.text} label="Copy message" />}
        <div className="max-w-[85%] rounded-2xl bg-(--crc-surface) px-4 py-3">
          {item.text && (
            <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-(--crc-fg)">
              {item.text}
            </div>
          )}
          {item.attachments && item.attachments.length > 0 && (
            <div
              className={`flex flex-wrap gap-1.5 ${item.text ? "mt-2" : ""}`}
            >
              {item.attachments.map((a, i) => (
                <AttachmentChip key={i} attachment={a} />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (item.type === "notice") {
    return (
      <div className="flex justify-center">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
            item.level === "warn"
              ? "border-(--crc-warning)/30 bg-(--crc-warning)/10 text-(--crc-warning)"
              : "border-(--crc-border) bg-(--crc-surface) text-(--crc-fg-muted)"
          }`}
        >
          <span
            className={`codicon ${item.level === "warn" ? "codicon-warning" : "codicon-info"}`}
          />
          {item.text}
        </span>
      </div>
    );
  }
  return <AssistantTurn turn={item.turn} />;
}

/**
 * How full the session's context window is, as the CLI reports it. A quiet
 * bar: it only matters as it approaches full, so it warms up as it fills.
 */
function ContextMeter({ context }: { context: ContextUsageView }) {
  const pct = Math.max(0, Math.min(100, Math.round(context.percentage)));
  const tone = pct >= 90 ? "bg-(--crc-danger)" : pct >= 70 ? "bg-(--crc-warning)" : "bg-(--crc-accent)";
  return (
    <span
      className="hidden items-center gap-2 md:inline-flex"
      title={`Context window: ${formatTokenCount(context.usedTokens)} of ${formatTokenCount(context.maxTokens)} tokens${
        context.autoCompact ? " · Claude compacts the conversation automatically as this fills" : ""
      }`}
    >
      <span className="block h-1.5 w-16 overflow-hidden rounded-full bg-(--crc-bg-inset)">
        <span className={`block h-full rounded-full transition-[width] duration-500 ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-[11px] tabular-nums text-(--crc-fg-muted)">{pct}%</span>
    </span>
  );
}

/** Claude's prose for this turn — what "copy the reply" puts on the clipboard (no thinking, no tool payloads). */
function replyTextOf(turn: TurnView): string {
  // BlockView's prose variant covers both "text" and "thinking", so narrow by
  // hand rather than with Extract (which collapses to never here).
  return turn.blocks.flatMap((blk) => (blk.kind === "text" && blk.text.trim() ? [blk.text.trim()] : [])).join("\n\n");
}

function AssistantTurn({ turn }: { turn: TurnView }) {
  const label = turnTriggerLabel(turn);
  const replyText = replyTextOf(turn);
  const steeredAfter = (index: number) =>
    turn.steeredPrompts.filter((p) => p.afterBlockIndex === index);
  return (
    <div className="crc-enter group space-y-3">
      {label && (
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-(--crc-fg-muted)">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-(--crc-surface) ring-1 ring-(--crc-border) ring-inset">
            <span className="codicon codicon-rocket text-[11px]" />
          </span>
          {label}
        </div>
      )}
      {steeredAfter(-1).map((p) => (
        <SteeredPrompt key={p.promptId} prompt={p} />
      ))}
      {turn.blocks.map((b, i) => (
        <Fragment key={i}>
          <Block block={b} turnRunning={turn.status === "running"} />
          {steeredAfter(i).map((p) => (
            <SteeredPrompt key={p.promptId} prompt={p} />
          ))}
        </Fragment>
      ))}
      {turn.status === "running" && (
        <div className="flex items-center gap-2 text-xs text-(--crc-fg-muted)">
          <span className="codicon codicon-loading codicon-modifier-spin" />
          Working…
        </div>
      )}
      {(turn.status !== "running" || replyText) && (
        <div className="flex flex-wrap items-center gap-2 pt-1 text-[11.5px] text-(--crc-fg-muted)">
          {turn.status === "done" && turn.costUsd != null && (
            <>
              <span>{formatDuration(turn.durationMs ?? 0)}</span>
              {(turn.inputTokens != null || turn.outputTokens != null) && (
                <>
                  <span>·</span>
                  <span>{formatTokenCount((turn.inputTokens ?? 0) + (turn.outputTokens ?? 0))} tokens</span>
                </>
              )}
              <span>·</span>
              <span>{formatCost(turn.costUsd)}</span>
              {/* One turn can answer several prompts — anything steered into it
                  mid-flight — so say what these totals cover; otherwise they
                  look like they belong to the last message alone. */}
              {turn.steeredPrompts.length > 0 && (
                <>
                  <span>·</span>
                  <span title="This turn answered your original message plus everything you sent while it was working.">
                    covers {turn.steeredPrompts.length + 1} messages
                  </span>
                </>
              )}
            </>
          )}
          {replyText && <CopyButton text={replyText} label="Copy reply" className="ml-auto" />}
        </div>
      )}
      {turn.status === "error" && turn.interrupted && (
        <div className="flex items-center gap-1.5 text-xs text-(--crc-fg-muted)">
          <span className="codicon codicon-debug-stop" /> Stopped
        </div>
      )}
      {turn.status === "error" && !turn.interrupted && (
        <div className="flex items-center gap-1.5 rounded-lg border border-(--crc-danger)/30 bg-(--crc-danger)/10 px-3 py-2 text-xs text-(--crc-danger)">
          <span className="codicon codicon-error" /> Turn failed:{" "}
          {turn.errorMessage}
        </div>
      )}
    </div>
  );
}

/** A prompt the controller sent while this turn was already running — shown inside the turn, where Claude picked it up. */
function SteeredPrompt({ prompt }: { prompt: SteeredPromptView }) {
  return (
    <div className="crc-enter group flex items-center justify-end gap-1" data-testid="steered-prompt">
      {prompt.text && <CopyButton text={prompt.text} label="Copy message" />}
      <div className="max-w-[85%] rounded-2xl bg-(--crc-surface) px-4 py-3">
        {prompt.text && (
          <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-(--crc-fg)">
            {prompt.text}
          </div>
        )}
        {prompt.attachments && prompt.attachments.length > 0 && (
          <div
            className={`flex flex-wrap gap-1.5 ${prompt.text ? "mt-2" : ""}`}
          >
            {prompt.attachments.map((a, i) => (
              <AttachmentChip key={i} attachment={a} />
            ))}
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-(--crc-fg-muted)">
          <span className="codicon codicon-debug-step-into text-[11px]" /> Sent
          while Claude was working — picked up mid-turn
        </div>
      </div>
    </div>
  );
}

/** Maps a tool name to a representative codicon glyph. */
function toolIcon(name: string): string {
  const map: Record<string, string> = {
    Bash: "terminal",
    BashOutput: "terminal",
    Read: "file",
    Write: "new-file",
    Edit: "edit",
    MultiEdit: "edit",
    NotebookEdit: "notebook",
    Grep: "search",
    Glob: "search",
    WebFetch: "globe",
    WebSearch: "search",
    Task: "rocket",
    TodoWrite: "checklist",
  };
  return map[name] ?? "tools";
}

function Block({
  block,
  turnRunning,
}: {
  block: BlockView;
  turnRunning: boolean;
}) {
  if (block.kind === "tool_use")
    return <ToolStep block={block} turnRunning={turnRunning} />;
  if (block.kind === "thinking") {
    return (
      <ThinkingBlock
        block={block}
        live={turnRunning && block.endedAtMs == null}
      />
    );
  }
  return <Markdown content={block.text} />;
}

/** What a tool call is, in words: the row label and the mono detail beside it. */
function describeTool(
  name: string,
  input: unknown,
): { label: string; meta: string | null } {
  const inp = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) =>
    typeof inp[k] === "string" ? (inp[k] as string) : null;
  const base = (path: string | null) =>
    path ? path.split("/").filter(Boolean).slice(-2).join("/") : null;
  switch (name) {
    case "Bash": {
      // The model's own one-line description IS the sentence worth showing;
      // only fall back to the command when it didn't write one.
      const described = str("description");
      return described
        ? { label: described, meta: null }
        : { label: "Ran a command", meta: truncate(str("command") ?? "", 72) };
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
      return {
        label: "Edited",
        meta: base(str("file_path") ?? str("notebook_path")),
      };
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

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The outcome glyph at the right of a step row. */
function Outcome({ kind, label }: { kind: "done" | "failed" | "running" | "stopped"; label?: string }) {
  const map = {
    done: { icon: "codicon-check", tone: "text-(--crc-success)", title: "Finished" },
    failed: { icon: "codicon-close", tone: "text-(--crc-danger)", title: "Failed" },
    running: { icon: "codicon-loading codicon-modifier-spin", tone: "text-(--crc-fg-muted)", title: "Running" },
    stopped: { icon: "codicon-primitive-square", tone: "text-(--crc-fg-muted)", title: "Stopped" },
  } as const;
  const m = map[kind];
  return (
    <span className={`inline-flex items-center gap-1.5 ${m.tone}`} title={m.title} aria-label={label ? `${m.title} · ${label}` : m.title}>
      {label && <span className="text-xs">{label}</span>}
      <span className={`codicon ${m.icon} text-[13px]`} />
    </span>
  );
}

/**
 * A tool call as a quiet disclosure line — "Ran a command ›" with its
 * outcome at the right — instead of a bordered card. Opens itself while the
 * call is running or when the payload is worth seeing unprompted (a diff, a
 * plan, a task list, a live agent), and folds shut once a routine call is done.
 */
function ToolStep({
  block,
  turnRunning,
}: {
  block: Extract<BlockView, { kind: "tool_use" }>;
  turnRunning: boolean;
}) {
  const filePath = extractFilePath(block.toolInput);
  const editView = parseEditView(block.toolName, block.toolInput);
  const todos =
    block.toolName === "TodoWrite" ? parseTodos(block.toolInput) : null;
  const plan = parsePlan(block.toolName, block.toolInput);
  const { label, meta } = describeTool(block.toolName, block.toolInput);
  const isAgent = block.toolName === "Agent" || block.toolName === "Task";
  // A background agent's nested feed never gets a closing tool_result (its
  // Task call returned immediately), so its completion notification is the
  // real "done" signal.
  const agentRunning =
    block.subagent?.status === "running" && !block.backgroundTask;
  const running = !block.result && !block.backgroundTask && turnRunning;
  const richPayload =
    editView != null || todos != null || plan != null || block.subagent != null;
  const restingOpen = richPayload && (agentRunning || block.subagent == null);
  const [open, setOpen] = useState(running || restingOpen);
  const userToggled = useRef(false);
  const wasRunning = useRef(running || agentRunning);
  useEffect(() => {
    // Auto-collapse a routine call once it settles — unless the user opened it themselves.
    const nowRunning = running || agentRunning;
    if (wasRunning.current && !nowRunning && !userToggled.current)
      setOpen(restingOpen);
    wasRunning.current = nowRunning;
  }, [running, agentRunning, restingOpen]);

  // One glyph language for every step: check = finished, cross = failed,
  // spinner = still going, square = stopped. No "ok" vs "done" — same thing.
  const toolCount = block.subagent?.blocks.filter((b) => b.kind === "tool_use").length ?? 0;
  const status = block.backgroundTask ? (
    <Outcome
      kind={block.backgroundTask.status === "completed" ? "done" : block.backgroundTask.status === "stopped" ? "stopped" : "failed"}
    />
  ) : block.subagent ? (
    agentRunning ? (
      <Outcome kind="running" label={`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`} />
    ) : (
      <Outcome kind="done" />
    )
  ) : block.result ? (
    <Outcome kind={block.result.ok ? "done" : "failed"} />
  ) : running ? (
    <Outcome kind="running" />
  ) : null;

  const command =
    block.toolName === "Bash"
      ? ((block.toolInput as { command?: string } | null)?.command ?? null)
      : null;

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => {
          userToggled.current = true;
          setOpen((o) => !o);
        }}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1 text-left text-[13px] text-(--crc-fg-muted) transition-colors hover:bg-(--crc-surface)/60 hover:text-(--crc-fg)"
      >
        <span className="text-(--crc-fg)">{label}</span>
        {meta && <span className="truncate font-mono text-xs">{meta}</span>}
        <span
          className={`codicon ${open ? "codicon-chevron-down" : "codicon-chevron-right"} shrink-0 text-[12px]`}
        />
        {filePath && isHosted() && (
          <span
            role="link"
            onClick={(e) => {
              e.stopPropagation();
              hostOpenFile(filePath);
            }}
            className="truncate text-xs text-(--crc-link) hover:underline"
            title={`Open ${filePath} in editor`}
          >
            open
          </span>
        )}
        {status && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs">
            {status}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-xl border border-(--crc-border)/70 p-3 text-xs">
          <div className="text-[13px] text-(--crc-fg)">{block.toolName}</div>
          {editView ? (
            <div className="overflow-hidden rounded-lg bg-(--crc-bg-inset)/70">
              <DiffView view={editView} />
            </div>
          ) : todos ? (
            <div className="rounded-lg bg-(--crc-bg-inset)/70">
              <TodoChecklist todos={todos} />
            </div>
          ) : plan ? (
            <div className="rounded-lg bg-(--crc-bg-inset)/70 px-3 py-2">
              <Markdown content={plan} />
            </div>
          ) : command ? (
            <ShellCode command={command} />
          ) : block.toolName !== "Agent" && block.toolName !== "Task" ? (
            <JsonCode json={truncate(JSON.stringify(block.toolInput, null, 2), 800)} />
          ) : null}
          {block.result && block.result.summary && !isAgent && (
            <pre
              className={`max-h-72 overflow-auto font-mono leading-relaxed break-words whitespace-pre-wrap ${
                block.result.ok ? "text-(--crc-fg-muted)" : "text-(--crc-danger)"
              }`}
            >
              {block.result.ok ? "" : "error: "}
              {truncate(block.result.summary, 800)}
            </pre>
          )}
          {block.subagent && <SubagentActivity subagent={block.subagent} />}
          {block.backgroundTask &&
            !block.subagent?.blocks.some((b) => b.kind === "text") && (
              <div className="flex items-start gap-1.5 text-(--crc-fg-muted)">
                <span
                  className={`codicon mt-0.5 ${
                    block.backgroundTask.status === "completed"
                      ? "codicon-pass-filled text-(--crc-success)"
                      : block.backgroundTask.status === "stopped"
                        ? "codicon-debug-stop"
                        : "codicon-error text-(--crc-danger)"
                  }`}
                />
                <span>{truncate(block.backgroundTask.summary, 800)}</span>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

/** A Task call's own nested activity, live-streamed via the Agent SDK's forwardSubagentText — the agent's own steps, indented under its row. */
function SubagentActivity({ subagent }: { subagent: SubagentView }) {
  return (
    <div className="ml-1 space-y-1 border-l border-(--crc-border)/60 pl-3">
      {subagent.taskDescription && (
        <div className="text-[12px] text-(--crc-fg-muted)">
          {subagent.subagentType ?? "Subagent"} — {subagent.taskDescription}
        </div>
      )}
      {subagent.blocks.map((b, i) => (
        <Block key={i} block={b} turnRunning={subagent.status === "running"} />
      ))}
    </div>
  );
}

/** Caps how many diff lines render before collapsing the rest into a note — a full-file Write can be thousands of lines. */
const MAX_DIFF_LINES_SHOWN = 400;

function DiffView({ view }: { view: EditToolView }) {
  const totalLines = view.hunks.reduce((n, h) => n + h.lines.length, 0);
  let shown = 0;
  return (
    <div className="overflow-x-auto font-mono">
      {view.hunks.map((hunk, hi) => {
        if (shown >= MAX_DIFF_LINES_SHOWN) return null;
        const remaining = MAX_DIFF_LINES_SHOWN - shown;
        const lines = hunk.lines.slice(0, remaining);
        shown += lines.length;
        return (
          <div
            key={hi}
            className={
              hi > 0 ? "border-t border-dashed border-(--crc-border)/60" : ""
            }
          >
            {lines.map((line, li) => (
              <div
                key={li}
                className={`whitespace-pre px-3 py-px leading-5 ${
                  line.type === "add"
                    ? "bg-(--crc-success)/12 text-(--crc-success)"
                    : line.type === "del"
                      ? "bg-(--crc-danger)/12 text-(--crc-danger)"
                      : "text-(--crc-fg-muted)"
                }`}
              >
                {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
                {line.text}
              </div>
            ))}
          </div>
        );
      })}
      {totalLines > MAX_DIFF_LINES_SHOWN && (
        <div className="px-3 py-1 text-(--crc-fg-muted)">
          … {totalLines - MAX_DIFF_LINES_SHOWN} more lines
        </div>
      )}
    </div>
  );
}

function TodoChecklist({ todos }: { todos: TodoItemView[] }) {
  return (
    <div className="px-3 py-2">
      {todos.map((t, i) => (
        <div key={i} className="flex items-start gap-2 py-0.5">
          <span
            className={`codicon mt-0.5 shrink-0 ${
              t.status === "completed"
                ? "codicon-pass-filled text-(--crc-success)"
                : t.status === "in_progress"
                  ? "codicon-sync codicon-modifier-spin text-(--crc-warning)"
                  : "codicon-circle-large-outline text-(--crc-fg-muted)"
            }`}
          />
          <span
            className={
              t.status === "completed"
                ? "text-(--crc-fg-muted) line-through"
                : t.status === "in_progress"
                  ? "font-medium text-(--crc-fg)"
                  : "text-(--crc-fg)"
            }
          >
            {t.status === "in_progress" && t.activeForm
              ? t.activeForm
              : t.content}
          </span>
        </div>
      ))}
    </div>
  );
}

function ThinkingBlock({
  block,
  live,
}: {
  block: Extract<BlockView, { kind: "text" | "thinking" }>;
  live: boolean;
}) {
  const elapsedSeconds = useElapsedSeconds(live ? block.startedAtMs : null);
  const verb = useThinkingVerb(live);
  const estimatedTokens = estimateTokens(block.text);

  return (
    <div className="border-l-2 border-(--crc-border) pl-3.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-(--crc-fg-muted)">
        {live ? (
          <>
            <span className="codicon codicon-loading codicon-modifier-spin text-(--crc-accent)" />
            <span>
              {verb}… {elapsedSeconds != null && `· ${elapsedSeconds}s `}
              {estimatedTokens > 0 &&
                `· ~${formatTokenCount(estimatedTokens)} tokens`}
            </span>
          </>
        ) : block.startedAtMs != null && block.endedAtMs != null ? (
          <>
            <span className="codicon codicon-sparkle text-[11px]" />
            <span>
              {block.endedAtMs - block.startedAtMs < 1000
                ? "Thought for a moment"
                : `Thought for ${formatDuration(block.endedAtMs - block.startedAtMs)}`}
            </span>
          </>
        ) : (
          <>
            <span className="codicon codicon-sparkle text-[11px]" />
            <span>Thinking</span>
          </>
        )}
      </div>
      <Markdown content={block.text} muted />
    </div>
  );
}

/** Ticks once a second while `startedAtMs` is set; null (no ticking) otherwise. */
function useElapsedSeconds(startedAtMs: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAtMs]);
  return startedAtMs == null
    ? null
    : Math.max(0, Math.round((now - startedAtMs) / 1000));
}

/** Rotates through THINKING_VERBS while `live`; holds still (and hides) otherwise. */
function useThinkingVerb(live: boolean): string {
  const [i, setI] = useState(() =>
    Math.floor(Math.random() * THINKING_VERBS.length),
  );
  useEffect(() => {
    if (!live) return;
    const id = setInterval(
      () => setI((v) => (v + 1) % THINKING_VERBS.length),
      2000,
    );
    return () => clearInterval(id);
  }, [live]);
  return THINKING_VERBS[i] ?? "Thinking";
}

function permissionTitle(toolName: string): string {
  switch (toolName) {
    case "Bash":
      return "Claude wants to run a command";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "Claude wants to edit a file";
    case "Write":
      return "Claude wants to write a file";
    case "Read":
      return "Claude wants to read a file";
    case "WebFetch":
    case "WebSearch":
      return "Claude wants to reach the web";
    default:
      return "Claude wants to run a tool";
  }
}

/** The one line that matters for approving a Bash call: the command itself. Null for every other tool. */
function permissionCommand(toolName: string, input: unknown): string | null {
  const command = (input as { command?: unknown } | null)?.command;
  return toolName === "Bash" && typeof command === "string" ? command : null;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function PermissionCard({
  perm,
  canAct,
  onDecide,
}: {
  perm: PermissionView;
  canAct: boolean;
  onDecide: (
    d: "allow" | "deny",
    updatedInput?: Record<string, unknown>,
  ) => void;
}) {
  const askQuestion = parseAskUserQuestion(perm.toolName, perm.toolInput);
  const plan =
    askQuestion == null ? parsePlan(perm.toolName, perm.toolInput) : null;
  const editView =
    plan == null && askQuestion == null
      ? parseEditView(perm.toolName, perm.toolInput)
      : null;
  const todos =
    plan == null && askQuestion == null && perm.toolName === "TodoWrite"
      ? parseTodos(perm.toolInput)
      : null;

  if (askQuestion != null) {
    return (
      <AskUserQuestionCard
        view={askQuestion}
        canAct={canAct}
        onSubmit={(answers) =>
          onDecide("allow", {
            ...(perm.toolInput as Record<string, unknown>),
            answers,
          })
        }
        onCancel={() => onDecide("deny")}
      />
    );
  }

  return (
    <div className="crc-enter crc-alarm rounded-2xl bg-(--crc-surface) px-4 py-3 shadow-(--crc-shadow-alarm)">
      <div className="flex items-center gap-3 text-sm text-(--crc-fg)">
        <span
          className={`codicon ${plan != null ? "codicon-checklist text-(--crc-warning)" : "codicon-shield text-(--crc-danger)"} shrink-0 text-[15px]`}
        />
        {plan != null ? (
          <span className="font-medium">Plan ready for review</span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-1.5 text-[13px]">
            <span className="font-medium">
              {permissionTitle(perm.toolName)}
            </span>
            <span className="text-(--crc-fg-muted)">·</span>
            <span className="font-mono text-xs text-(--crc-fg-muted)">
              {perm.toolName}
            </span>
          </span>
        )}
      </div>
      {plan != null ? (
        <div className="mt-2 max-h-64 overflow-auto rounded-lg bg-(--crc-surface) p-2 text-xs">
          <Markdown content={plan} />
        </div>
      ) : editView ? (
        <div className="mt-1 max-h-64 overflow-auto rounded-lg bg-(--crc-surface) text-xs">
          <DiffView view={editView} />
        </div>
      ) : todos ? (
        <div className="mt-1 max-h-48 overflow-auto rounded-lg bg-(--crc-surface) text-xs">
          <TodoChecklist todos={todos} />
        </div>
      ) : (
        <div className="mt-2.5 max-h-32 overflow-auto text-xs">
          {permissionCommand(perm.toolName, perm.toolInput) ? (
            <ShellCode command={permissionCommand(perm.toolName, perm.toolInput)!} />
          ) : (
            <JsonCode json={truncate(JSON.stringify(perm.toolInput, null, 2), 500)} />
          )}
        </div>
      )}
      {canAct ? (
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={() => onDecide("allow")}>
            <span className="codicon codicon-check" />{" "}
            {plan != null ? "Approve plan" : "Allow"}
          </Button>
          <Button variant="danger" onClick={() => onDecide("deny")}>
            <span className="codicon codicon-close" />{" "}
            {plan != null ? "Keep planning" : "Deny"}
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-xs text-(--crc-fg-muted)">
          Only the controller can respond.
        </div>
      )}
    </div>
  );
}

const OTHER_OPTION = "__other__";

/**
 * AskUserQuestion's own card: clickable option buttons instead of raw-JSON
 * Allow/Deny, one tab per question when there's more than one. The model
 * never includes an "Other" choice itself (the tool's contract says the
 * caller provides it), so it's added here for every question.
 */
function AskUserQuestionCard({
  view,
  canAct,
  onSubmit,
  onCancel,
}: {
  view: AskUserQuestionView;
  canAct: boolean;
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [selected, setSelected] = useState<string[][]>(() =>
    view.questions.map(() => []),
  );
  const [otherText, setOtherText] = useState<string[]>(() =>
    view.questions.map(() => ""),
  );

  useEffect(() => {
    if (!canAct) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canAct, onCancel]);

  const question = view.questions[activeIndex]!;
  const activeSelected = selected[activeIndex] ?? [];

  function toggleOption(label: string): void {
    setSelected((prev) => {
      const next = prev.slice();
      const current = next[activeIndex] ?? [];
      next[activeIndex] = question.multiSelect
        ? current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
        : current.includes(label)
          ? []
          : [label];
      return next;
    });
  }

  const allAnswered = view.questions.every((_, i) => {
    const sel = selected[i] ?? [];
    if (sel.length === 0) return false;
    return (
      !sel.includes(OTHER_OPTION) || (otherText[i]?.trim().length ?? 0) > 0
    );
  });

  function handleSubmit(): void {
    const answers: Record<string, string> = {};
    view.questions.forEach((q, i) => {
      const labels = (selected[i] ?? []).map((l) =>
        l === OTHER_OPTION ? (otherText[i]?.trim() ?? "") : l,
      );
      answers[q.question] = labels.join(", ");
    });
    onSubmit(answers);
  }

  return (
    <div className="rounded-sm border-l-2 border-(--crc-warning) bg-(--crc-warning)/10 p-3">
      {view.questions.length > 1 && (
        <div className="mb-2 flex items-center gap-3 border-b border-(--crc-border) text-xs">
          {view.questions.map((q, i) => (
            <button
              key={q.header + i}
              onClick={() => setActiveIndex(i)}
              className={`-mb-px border-b-2 pb-1.5 ${
                i === activeIndex
                  ? "border-(--crc-warning) text-(--crc-fg)"
                  : "border-transparent text-(--crc-fg-muted) hover:text-(--crc-fg)"
              }`}
            >
              {q.header}
            </button>
          ))}
        </div>
      )}
      <p className="text-sm text-(--crc-fg)">{question.question}</p>
      <div className="mt-2 space-y-1.5 text-xs">
        {question.options.map((opt) => {
          const isSelected = activeSelected.includes(opt.label);
          return (
            <button
              key={opt.label}
              disabled={!canAct}
              onClick={() => toggleOption(opt.label)}
              className={`w-full rounded-sm border px-3 py-2 text-left transition disabled:cursor-not-allowed ${
                isSelected
                  ? "border-(--crc-warning) bg-(--crc-bg-elevated)"
                  : "border-(--crc-border) bg-(--crc-bg-elevated)/40 hover:bg-(--crc-bg-elevated)"
              }`}
            >
              <div className="font-medium text-(--crc-fg)">{opt.label}</div>
              <div className="text-(--crc-fg-muted)">{opt.description}</div>
            </button>
          );
        })}
        <button
          disabled={!canAct}
          onClick={() => toggleOption(OTHER_OPTION)}
          className={`w-full rounded-sm border px-3 py-2 text-left transition disabled:cursor-not-allowed ${
            activeSelected.includes(OTHER_OPTION)
              ? "border-(--crc-warning) bg-(--crc-bg-elevated)"
              : "border-(--crc-border) bg-(--crc-bg-elevated)/40 hover:bg-(--crc-bg-elevated)"
          }`}
        >
          <div className="font-medium text-(--crc-fg)">Other</div>
        </button>
        {activeSelected.includes(OTHER_OPTION) && (
          <input
            autoFocus
            disabled={!canAct}
            value={otherText[activeIndex] ?? ""}
            onChange={(e) =>
              setOtherText((prev) => {
                const next = prev.slice();
                next[activeIndex] = e.target.value;
                return next;
              })
            }
            placeholder="Type your answer…"
            className="w-full rounded-sm border border-(--crc-border) bg-(--crc-bg) px-2 py-1.5 text-(--crc-fg)"
          />
        )}
      </div>
      {canAct ? (
        <div className="mt-2 flex items-center gap-2">
          <Button
            variant="primary"
            disabled={!allAnswered}
            onClick={handleSubmit}
          >
            <span className="codicon codicon-check" /> Submit answers
          </Button>
          <span className="text-xs text-(--crc-fg-muted)">Esc to cancel</span>
        </div>
      ) : (
        <div className="mt-2 text-xs text-(--crc-fg-muted)">
          Only the controller can respond.
        </div>
      )}
    </div>
  );
}

/** A picked attachment before it's sent — same wire shape as `Attachment` plus client-only bookkeeping. */
type PendingAttachment = Attachment & { id: string };

/** Reads a File into wire-format base64, or an error message if it's an unsupported type or too large. */
function readFileAsAttachment(
  file: File,
): Promise<PendingAttachment | { error: string }> {
  const mediaType = classifyAttachment(file);
  if (!mediaType) {
    return Promise.resolve({
      error: `${file.name}: unsupported file type — reference it by its path in the prompt instead.`,
    });
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Promise.resolve({
      error: `${file.name}: too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB).`,
    });
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string; // "data:<mediaType>;base64,<data>"
      const data = result.slice(result.indexOf(",") + 1);
      resolve({ id: crypto.randomUUID(), name: file.name, mediaType, data });
    };
    reader.onerror = () =>
      resolve({ error: `${file.name}: couldn't read file.` });
    reader.readAsDataURL(file);
  });
}

/** One attached file: a thumbnail for images, a file chip otherwise. `onRemove` omitted renders it read-only (timeline history). */
function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove?: () => void;
}) {
  const isImage = attachment.mediaType.startsWith("image/");
  const [previewing, setPreviewing] = useState(false);
  return (
    <>
      <div
        className={`flex items-center gap-1.5 rounded-xl border border-(--crc-border) bg-(--crc-surface) py-1 pl-1 pr-2 text-xs ${isImage ? "cursor-pointer" : ""}`}
        onClick={isImage ? () => setPreviewing(true) : undefined}
      >
        {isImage ? (
          <img
            src={`data:${attachment.mediaType};base64,${attachment.data}`}
            alt={attachment.name}
            className="h-6 w-6 rounded-sm object-cover"
          />
        ) : (
          <span className="codicon codicon-file text-(--crc-fg-muted)" />
        )}
        <span
          className="max-w-40 truncate text-(--crc-fg)"
          title={attachment.name}
        >
          {attachment.name}
        </span>
        {onRemove && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="text-(--crc-fg-muted) hover:text-(--crc-danger)"
            title="Remove"
          >
            <span className="codicon codicon-close" />
          </button>
        )}
      </div>
      {previewing && (
        <ImagePreviewDialog
          attachment={attachment}
          onClose={() => setPreviewing(false)}
        />
      )}
    </>
  );
}

/** Full-screen preview of an attached image, dismissed by backdrop click, X, or Escape. */
function ImagePreviewDialog({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/80 hover:text-white"
        title="Close"
      >
        <span className="codicon codicon-close text-2xl" />
      </button>
      <img
        src={`data:${attachment.mediaType};base64,${attachment.data}`}
        alt={attachment.name}
        className="max-h-full max-w-full rounded-sm object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

function Composer({
  sessionId,
  disabled,
  reason,
  onSend,
  busy,
  onStop,
}: {
  sessionId: string;
  disabled: boolean;
  reason: string;
  onSend: (
    text: string,
    opts?: {
      model?: string;
      maxThinkingTokens?: number | null;
      permissionMode?: PermissionModeKey;
      attachments?: Attachment[];
    },
  ) => void;
  busy: boolean;
  onStop: () => void;
}) {
  const { rest, realtime } = useClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // All three persisted in localStorage (see composerPrefs.ts) so they don't
  // silently reset to their defaults every refresh/reopen. model starts ""
  // (nothing persisted yet) until either a saved pick loads or capabilities
  // arrive and default it to the SDK's own recommended entry.
  const [model, setModelState] = useState(loadModel);
  const [effortKey, setEffortKeyState] = useState(loadEffortKey);
  const [permissionMode, setPermissionModeState] =
    useState<PermissionModeKey>(loadPermissionMode);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse>({
    models: [],
    commands: [],
  });
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [openMenu, setOpenMenu] = useState<"model" | "effort" | "mode" | null>(
    null,
  );
  const [customModel, setCustomModel] = useState("");

  useEffect(() => {
    rest
      .getCapabilities()
      .then(setCapabilities)
      .catch(() => {});
  }, [rest]);

  // supportedModels() already includes its own "Default (recommended)" entry
  // (first in the list) — no need for our own placeholder on top of it. Once
  // the real list loads, default the selection to that entry rather than an
  // empty value that wouldn't match any <option>.
  useEffect(() => {
    if (!model && capabilities.models.length > 0)
      setModel(capabilities.models[0]?.value ?? "");
  }, [capabilities, model]);

  // Move focus to the composer as soon as this device gains control (whether
  // by taking it explicitly or via auto-claim on session creation).
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  const effort =
    EFFORT_LEVELS.find((e) => e.key === effortKey) ?? EFFORT_LEVELS[0];
  const mode =
    PERMISSION_MODES.find((m) => m.key === permissionMode) ??
    PERMISSION_MODES[0];
  const selectedModel = capabilities.models.find((m) => m.value === model);
  const suggestions =
    text.startsWith("/") && text.length > 1 && !text.includes(" ")
      ? capabilities.commands.filter((c) =>
          c.name.toLowerCase().startsWith(text.slice(1).toLowerCase()),
        )
      : [];

  /**
   * Persist the pick, and — if a turn is running right now — push it live via
   * the SDK's mid-session control request instead of only taking effect on
   * the next prompt. This is what makes flipping Manual -> Auto while a
   * permission request is sitting there actually stop the rest of that turn
   * from asking again, instead of only changing what the NEXT turn does.
   */
  function setPermissionMode(next: PermissionModeKey) {
    setPermissionModeState(next);
    savePermissionMode(next);
    if (busy) realtime.setPermissionMode(sessionId, next);
  }

  function setModel(next: string) {
    setModelState(next);
    saveModel(next);
  }

  function setEffortKey(next: string) {
    setEffortKeyState(next);
    saveEffortKey(next);
  }

  function send() {
    const t = text.trim();
    if ((!t && attachments.length === 0) || disabled) return;
    onSend(t, {
      model: model || undefined,
      maxThinkingTokens: effort?.maxThinkingTokens ?? undefined,
      permissionMode,
      attachments:
        attachments.length > 0
          ? attachments.map(({ id: _id, ...a }) => a)
          : undefined,
    });
    setText("");
    setAttachments([]);
    setAttachError(null);
  }

  /** Reads and validates dropped/picked/pasted files, appending whatever's accepted. */
  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;

    const room = MAX_ATTACHMENTS_PER_PROMPT - attachments.length;
    if (room <= 0) {
      setAttachError(
        `Up to ${MAX_ATTACHMENTS_PER_PROMPT} attachments per message.`,
      );
      return;
    }

    const results = await Promise.all(
      list.slice(0, room).map(readFileAsAttachment),
    );
    const accepted = results.filter(
      (r): r is PendingAttachment => !("error" in r),
    );
    const errors = results
      .filter((r): r is { error: string } => "error" in r)
      .map((r) => r.error);
    if (list.length > room)
      errors.push(
        `Only ${room} more attachment${room === 1 ? "" : "s"} allowed — dropped the rest.`,
      );

    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
    setAttachError(errors[0] ?? null);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((f): f is File => f != null);
    if (files.length > 0) {
      e.preventDefault(); // a pasted screenshot has no useful text fallback
      void addFiles(files);
    }
  }

  function pickSuggestion(name: string) {
    setText(`/${name} `);
    setSuggestionIndex(0);
  }

  function useCustomModel() {
    const id = customModel.trim();
    if (!id) return;
    setModel(id);
    setCustomModel("");
    setOpenMenu(null);
  }

  /** The open picker's menu, anchored to its own button and opening upward. */
  const menuPanel = (align: "start" | "end") =>
    openMenu ? (
      <div
        className={`crc-enter absolute bottom-full z-50 mb-2 max-h-80 w-80 overflow-y-auto rounded-xl bg-(--crc-surface) p-1 text-xs shadow-(--crc-shadow-lg) ${
          align === "end" ? "right-0" : "left-0"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 pt-2 pb-1.5 text-[11px] font-medium text-(--crc-fg-muted)">
          {openMenu === "model"
            ? "Select a model"
            : openMenu === "effort"
              ? "Thinking effort"
              : "Permissions"}
        </div>
        {openMenu === "model"
          ? [
              ...capabilities.models.map((m) => (
                <button
                  key={m.value}
                  onClick={() => {
                    setModel(m.value);
                    setOpenMenu(null);
                  }}
                  className="flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-(--crc-hover)"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-(--crc-fg)">
                      {m.displayName}
                    </div>
                    {m.description && (
                      <div className="truncate text-(--crc-fg-muted)">
                        {m.description}
                      </div>
                    )}
                  </div>
                  {m.value === model && (
                    <span className="codicon codicon-check shrink-0 text-(--crc-fg)" />
                  )}
                </button>
              )),
              <div
                key="custom"
                className="mt-1 border-t border-(--crc-border)/60 p-2"
              >
                <div className="mb-1 text-(--crc-fg-muted)">
                  Not listed? Enter a model ID directly:
                </div>
                <div className="flex gap-1.5">
                  <input
                    value={customModel}
                    onChange={(ev) => setCustomModel(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") useCustomModel();
                    }}
                    placeholder="claude-fable-5-1"
                    spellCheck={false}
                    autoComplete="off"
                    className="crc-input min-w-0 flex-1 px-2 py-1 text-xs"
                  />
                  <Button
                    variant="default"
                    disabled={!customModel.trim()}
                    onClick={useCustomModel}
                    className="shrink-0"
                  >
                    Use
                  </Button>
                </div>
              </div>,
            ]
          : openMenu === "effort"
            ? EFFORT_LEVELS.map((e) => (
                <button
                  key={e.key}
                  onClick={() => {
                    setEffortKey(e.key);
                    setOpenMenu(null);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-(--crc-hover)"
                >
                  <span className="font-medium text-(--crc-fg)">{e.label}</span>
                  {e.key === effortKey && (
                    <span className="codicon codicon-check shrink-0 text-(--crc-fg)" />
                  )}
                </button>
              ))
            : PERMISSION_MODES.map((m) => (
                <button
                  key={m.key}
                  onClick={() => {
                    setPermissionMode(m.key);
                    setOpenMenu(null);
                  }}
                  className="flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2 text-left hover:bg-(--crc-hover)"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-(--crc-fg)">{m.label}</div>
                    <div className="truncate text-(--crc-fg-muted)">
                      {m.description}
                    </div>
                  </div>
                  {m.key === permissionMode && (
                    <span className="codicon codicon-check shrink-0 text-(--crc-fg)" />
                  )}
                </button>
              ))}
      </div>
    ) : null;

  return (
    <div
      className="relative px-6 pb-3 pt-1"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length > 0)
          void addFiles(e.dataTransfer.files);
      }}
    >
      <div className="relative mx-auto w-full max-w-3xl">
        {suggestions.length > 0 && (
          <div className="crc-enter absolute bottom-full left-4 right-4 z-10 mb-2 max-h-48 overflow-y-auto rounded-xl border border-(--crc-border) bg-(--crc-surface) p-1 shadow-(--crc-shadow-lg)">
            {suggestions.map((c, i) => (
              <button
                key={c.name}
                onClick={() => pickSuggestion(c.name)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs ${
                  i === suggestionIndex
                    ? "bg-(--crc-selected) text-(--crc-selected-fg)"
                    : "text-(--crc-fg)"
                }`}
              >
                <span className="font-mono text-(--crc-link)">/{c.name}</span>
                <span className="truncate text-(--crc-fg-muted)">
                  {c.description}
                </span>
                {c.argumentHint && (
                  <span className="ml-auto shrink-0 text-(--crc-fg-muted)">
                    {c.argumentHint}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {openMenu && (
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpenMenu(null)}
          />
        )}

        <div
          className={`rounded-2xl bg-(--crc-surface) px-1 pt-1 pb-1 shadow-(--crc-shadow-sm) transition-[box-shadow,opacity] duration-150 focus-within:ring-2 focus-within:ring-(--crc-accent)/25 ${
            dragOver ? "ring-2 ring-(--crc-accent)/40" : ""
          }`}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {attachments.map((a) => (
                <AttachmentChip
                  key={a.id}
                  attachment={a}
                  onRemove={() => removeAttachment(a.id)}
                />
              ))}
            </div>
          )}

          {attachError && (
            <div className="px-3 pt-2 text-xs text-(--crc-danger)">
              {attachError}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSuggestionIndex(0);
            }}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (suggestions.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSuggestionIndex((i) => (i + 1) % suggestions.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSuggestionIndex(
                    (i) => (i - 1 + suggestions.length) % suggestions.length,
                  );
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  const picked = suggestions[suggestionIndex];
                  if (picked) pickSuggestion(picked.name);
                  return;
                }
                if (e.key === "Escape") {
                  setText("");
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            disabled={disabled}
            placeholder={
              disabled
                ? reason
                : busy
                  ? "Add to what Claude is doing…"
                  : "Reply to Claude…"
            }
            className="block max-h-48 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[14px] leading-relaxed text-(--crc-fg) outline-none [field-sizing:content] placeholder:text-(--crc-fg-muted)"
          />

          <div className="flex items-center gap-1 px-1 pb-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,.md,.json,.csv,.log,.yaml,.yml"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = ""; // allow re-picking the same file
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              title="Attach images, PDFs, or text files"
              className="h-7 w-7"
            >
              <span className="codicon codicon-add" />
            </Button>
            <div className="relative">
              <PickerButton
                label={mode?.label ?? "Manual"}
                open={openMenu === "mode"}
                onToggle={() => setOpenMenu((v) => (v === "mode" ? null : "mode"))}
              />
              {openMenu === "mode" && menuPanel("start")}
            </div>
            <div className="ml-auto flex items-center gap-1">
              <div className="relative">
                <PickerButton
                  label={
                    capabilities.models.length === 0 && !model ? (
                      <Skeleton className="h-3 w-24" />
                    ) : (
                      (selectedModel?.displayName ?? model ?? "Default")
                    )
                  }
                  open={openMenu === "model"}
                  onToggle={() => setOpenMenu((v) => (v === "model" ? null : "model"))}
                />
                {openMenu === "model" && menuPanel("end")}
              </div>
              <div className="relative">
                <PickerButton
                  label={effort?.label ?? "Medium"}
                  open={openMenu === "effort"}
                  onToggle={() => setOpenMenu((v) => (v === "effort" ? null : "effort"))}
                />
                {openMenu === "effort" && menuPanel("end")}
              </div>
              {busy ? (
                <button
                  type="button"
                  onClick={onStop}
                  aria-label="Stop"
                  title="Stop the current turn"
                  className="grid h-8 w-8 place-items-center rounded-full bg-(--crc-bg-inset) text-(--crc-fg) transition-colors hover:bg-(--crc-hover)"
                >
                  <span className="codicon codicon-primitive-square text-[11px]" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={send}
                  aria-label="Send"
                  title="Send (Enter)"
                  disabled={disabled || (!text.trim() && attachments.length === 0)}
                  className="grid h-8 w-8 place-items-center rounded-full bg-(--crc-accent) text-(--crc-accent-fg) transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="codicon codicon-arrow-up text-base" />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-2 text-center text-[11px] text-(--crc-fg-muted)">
          Enter to send · Shift+Enter newline · / for commands
        </div>
      </div>
    </div>
  );
}

function PickerButton({
  label,
  open,
  onToggle,
}: {
  label: React.ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`flex h-7 max-w-44 items-center gap-1 rounded-lg px-1.5 text-xs transition-colors hover:bg-(--crc-bg-inset) hover:text-(--crc-fg) ${
        open ? "bg-(--crc-bg-inset) text-(--crc-fg)" : "text-(--crc-fg-muted)"
      }`}
    >
      <span className="truncate">{label}</span>
      <span className="codicon codicon-chevron-down text-[11px] opacity-70" />
    </button>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Tools like Read/Edit/Write carry a `file_path`; surface it for host open. */
function extractFilePath(input: unknown): string | null {
  if (input && typeof input === "object" && "file_path" in input) {
    const p = (input as { file_path: unknown }).file_path;
    if (typeof p === "string" && p.length > 0) return p;
  }
  return null;
}
