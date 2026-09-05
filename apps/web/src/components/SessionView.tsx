import {
  classifyAttachment,
  EFFORT_LEVELS,
  estimateTokens,
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
import { Markdown } from "./Markdown.js";
import { Button, StatusBadge } from "./ui.js";

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

  // Keep pinned to the newest output as tokens stream in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [conv]);

  const isController = conv.controller === config.deviceId;
  const status = conv.status ?? "idle";

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-(--crc-border) bg-(--crc-bg-elevated) px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-[15px] font-semibold tracking-tight text-(--crc-fg)">{conv.repoName ?? "…"}</span>
              {displayBranch(conv.branch) && (
                <span className="hidden shrink-0 items-center gap-1 rounded-md bg-(--crc-surface) px-1.5 py-0.5 font-mono text-[11px] text-(--crc-fg-muted) md:inline-flex">
                  <span className="codicon codicon-git-branch text-[11px]" />
                  {displayBranch(conv.branch)}
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-(--crc-fg-muted)">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  conv.controller ? (isController ? "bg-(--crc-accent)" : "bg-(--crc-fg-muted)") : "bg-(--crc-border)"
                }`}
              />
              {conv.controller
                ? isController
                  ? "You're in control"
                  : `${conv.controllerName ?? conv.controller} is in control — you're watching`
                : "Nobody is in control"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={status} pendingPermission={conv.pending.length > 0} />
          {!isController && (
            <Button variant="primary" onClick={() => realtime.takeControl(sessionId)}>
              <span className="codicon codicon-record-keys" /> Take control
            </Button>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-5 px-6 py-6">
          {conv.timeline.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-24 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-(--crc-surface) text-(--crc-fg-muted) shadow-(--crc-shadow-sm)">
                <span className="codicon codicon-sparkle text-xl" />
              </span>
              <div>
                <div className="text-sm font-medium text-(--crc-fg)">Nothing here yet</div>
                <div className="mt-1 text-xs text-(--crc-fg-muted)">
                  {isController ? "Send a prompt below to get Claude going." : "Take control and send a prompt to get Claude going."}
                </div>
              </div>
            </div>
          )}
          {conv.timeline.map((item, i) => (
            <TimelineRow key={i} item={item} />
          ))}
        </div>
      </div>

      {/* Pending permissions */}
      {conv.pending.length > 0 && (
        <div className="border-t border-(--crc-border)/60 bg-(--crc-bg-elevated) px-6 py-3 shadow-[0_-12px_32px_-16px_rgba(0,0,0,0.45)]">
          <div className="mx-auto w-full max-w-4xl space-y-2">
          {conv.pending.map((p) => (
            <PermissionCard
              key={p.requestId}
              perm={p}
              canAct={isController}
              onDecide={(d, updatedInput) => realtime.resolvePermission(sessionId, p.requestId, d, updatedInput)}
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
        <div className="border-t border-(--crc-border)/60 bg-(--crc-bg-elevated)/60 px-6 py-2">
          <div className="mx-auto w-full max-w-4xl space-y-1">
          <div className="text-[11px] text-(--crc-fg-muted)">
            {conv.queuedPrompts.length === 1 ? "1 message queued" : `${conv.queuedPrompts.length} messages queued`} — will send once the current turn finishes
          </div>
          {conv.queuedPrompts.map((q) => (
            <div key={q.promptId} className="flex items-center gap-1.5 truncate text-xs text-(--crc-fg-muted)">
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
      <div className="crc-enter flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-(--crc-accent)/12 px-4 py-2.5 ring-1 ring-(--crc-accent)/20 ring-inset">
          {item.text && <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-(--crc-fg)">{item.text}</div>}
          {item.attachments && item.attachments.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 ${item.text ? "mt-2" : ""}`}>
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
          <span className={`codicon ${item.level === "warn" ? "codicon-warning" : "codicon-info"}`} />
          {item.text}
        </span>
      </div>
    );
  }
  return <AssistantTurn turn={item.turn} />;
}

function AssistantTurn({ turn }: { turn: TurnView }) {
  const label = turnTriggerLabel(turn);
  const steeredAfter = (index: number) => turn.steeredPrompts.filter((p) => p.afterBlockIndex === index);
  return (
    <div className="crc-enter space-y-3">
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
      {turn.status === "done" && turn.costUsd != null && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-(--crc-fg-muted)">
          <MetaPill>${turn.costUsd.toFixed(4)}</MetaPill>
          <MetaPill>{formatDuration(turn.durationMs ?? 0)}</MetaPill>
          {(turn.inputTokens != null || turn.outputTokens != null) && (
            <MetaPill>{formatTokenCount((turn.inputTokens ?? 0) + (turn.outputTokens ?? 0))} tokens</MetaPill>
          )}
        </div>
      )}
      {turn.status === "error" && turn.interrupted && (
        <div className="flex items-center gap-1.5 text-xs text-(--crc-fg-muted)">
          <span className="codicon codicon-debug-stop" /> Stopped
        </div>
      )}
      {turn.status === "error" && !turn.interrupted && (
        <div className="flex items-center gap-1.5 rounded-lg border border-(--crc-danger)/30 bg-(--crc-danger)/10 px-3 py-2 text-xs text-(--crc-danger)">
          <span className="codicon codicon-error" /> Turn failed: {turn.errorMessage}
        </div>
      )}
    </div>
  );
}

function MetaPill({ children }: { children: React.ReactNode }) {
  return <span className="rounded-md bg-(--crc-surface) px-1.5 py-0.5 ring-1 ring-(--crc-border) ring-inset">{children}</span>;
}

/** A prompt the controller sent while this turn was already running — shown inside the turn, where Claude picked it up. */
function SteeredPrompt({ prompt }: { prompt: SteeredPromptView }) {
  return (
    <div className="crc-enter flex justify-end" data-testid="steered-prompt">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-(--crc-accent)/12 px-4 py-2.5 ring-1 ring-(--crc-accent)/20 ring-inset">
        {prompt.text && <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-(--crc-fg)">{prompt.text}</div>}
        {prompt.attachments && prompt.attachments.length > 0 && (
          <div className={`flex flex-wrap gap-1.5 ${prompt.text ? "mt-2" : ""}`}>
            {prompt.attachments.map((a, i) => (
              <AttachmentChip key={i} attachment={a} />
            ))}
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-1 text-[11px] text-(--crc-fg-muted)">
          <span className="codicon codicon-debug-step-into text-[11px]" /> Sent while Claude was working — picked up mid-turn
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

function Block({ block, turnRunning }: { block: BlockView; turnRunning: boolean }) {
  if (block.kind === "tool_use") {
    const filePath = extractFilePath(block.toolInput);
    const editView = parseEditView(block.toolName, block.toolInput);
    const todos = block.toolName === "TodoWrite" ? parseTodos(block.toolInput) : null;
    const plan = parsePlan(block.toolName, block.toolInput);
    return (
      <div className="overflow-hidden rounded-xl bg-(--crc-surface) text-xs shadow-(--crc-shadow-xs)">
        <div className="flex items-center gap-2 px-3 py-2 text-(--crc-fg)">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-(--crc-bg-inset) text-(--crc-fg-muted)">
            <span className={`codicon codicon-${toolIcon(block.toolName)} text-[12px]`} />
          </span>
          <span className="font-mono font-medium">{block.toolName}</span>
          {block.result && (
            <span
              className={`ml-1 h-1.5 w-1.5 rounded-full ${block.result.ok ? "bg-(--crc-success)" : "bg-(--crc-danger)"}`}
              title={block.result.ok ? "Succeeded" : "Failed"}
            />
          )}
          {!block.result && turnRunning && !block.backgroundTask && (
            <span className="codicon codicon-loading codicon-modifier-spin ml-1 text-[11px] text-(--crc-fg-muted)" />
          )}
          {filePath && isHosted() && (
            <button
              onClick={() => hostOpenFile(filePath)}
              className="ml-auto truncate text-(--crc-link) hover:underline"
              title={`Open ${filePath} in editor`}
            >
              {filePath.split("/").pop()}
            </button>
          )}
        </div>
        {editView ? (
          <DiffView view={editView} />
        ) : todos ? (
          <TodoChecklist todos={todos} />
        ) : plan ? (
          <div className="border-t border-(--crc-border)/60 px-3 py-2">
            <Markdown content={plan} />
          </div>
        ) : (
          <pre className="overflow-x-auto border-t border-(--crc-border)/60 bg-(--crc-bg-inset)/50 px-3 py-2 font-mono leading-relaxed text-(--crc-fg-muted)">
            {truncate(JSON.stringify(block.toolInput, null, 2), 800)}
          </pre>
        )}
        {block.result && (
          <pre
            className={`max-h-72 overflow-auto border-t border-(--crc-border)/60 px-3 py-2 font-mono leading-relaxed ${
              block.result.ok ? "text-(--crc-fg-muted)" : "bg-(--crc-danger)/8 text-(--crc-danger)"
            }`}
          >
            {block.result.ok ? "" : "error: "}
            {truncate(block.result.summary, 800)}
          </pre>
        )}
        {block.subagent && <SubagentActivity subagent={block.subagent} />}
        {block.backgroundTask && (
          <div className="flex items-start gap-1.5 border-t border-(--crc-border)/60 bg-(--crc-bg-inset)/40 px-3 py-2 text-(--crc-fg-muted)">
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
    );
  }
  if (block.kind === "thinking") {
    return <ThinkingBlock block={block} live={turnRunning && block.endedAtMs == null} />;
  }
  return <Markdown content={block.text} />;
}

/** A Task call's own nested activity, live-streamed via the Agent SDK's forwardSubagentText — collapsible, open by default while running. */
function SubagentActivity({ subagent }: { subagent: SubagentView }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const prevStatus = useRef(subagent.status);

  useEffect(() => {
    // Native <details>'s `open` attribute isn't reliably reactive as a React
    // prop across re-renders (React applies it at mount but doesn't force-sync
    // it on later updates) — drive the one transition we care about
    // (running -> done) imperatively so it actually collapses once finished.
    if (prevStatus.current === "running" && subagent.status === "done" && detailsRef.current) {
      detailsRef.current.open = false;
    }
    prevStatus.current = subagent.status;
  }, [subagent.status]);

  return (
    <details ref={detailsRef} className="border-t border-(--crc-border)/60 px-3 py-2" open={subagent.status === "running"}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md text-(--crc-fg-muted) hover:text-(--crc-fg)">
        <span
          className={`codicon ${subagent.status === "running" ? "codicon-loading codicon-modifier-spin" : "codicon-pass-filled text-(--crc-success)"}`}
        />
        <span className="font-medium text-(--crc-fg)">{subagent.subagentType ?? "Subagent"}</span>
        {subagent.taskDescription && <span className="truncate">— {subagent.taskDescription}</span>}
      </summary>
      <div className="mt-2 space-y-2 border-l-2 border-(--crc-accent)/30 pl-3">
        {subagent.blocks.map((b, i) => (
          <Block key={i} block={b} turnRunning={subagent.status === "running"} />
        ))}
      </div>
    </details>
  );
}

/** Caps how many diff lines render before collapsing the rest into a note — a full-file Write can be thousands of lines. */
const MAX_DIFF_LINES_SHOWN = 400;

function DiffView({ view }: { view: EditToolView }) {
  const totalLines = view.hunks.reduce((n, h) => n + h.lines.length, 0);
  let shown = 0;
  return (
    <div className="overflow-x-auto border-t border-(--crc-border)/60 font-mono">
      {view.hunks.map((hunk, hi) => {
        if (shown >= MAX_DIFF_LINES_SHOWN) return null;
        const remaining = MAX_DIFF_LINES_SHOWN - shown;
        const lines = hunk.lines.slice(0, remaining);
        shown += lines.length;
        return (
          <div key={hi} className={hi > 0 ? "border-t border-dashed border-(--crc-border)/60" : ""}>
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
        <div className="px-3 py-1 text-(--crc-fg-muted)">… {totalLines - MAX_DIFF_LINES_SHOWN} more lines</div>
      )}
    </div>
  );
}

function TodoChecklist({ todos }: { todos: TodoItemView[] }) {
  return (
    <div className="border-t border-(--crc-border)/60 px-3 py-1.5">
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
            {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
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
              {estimatedTokens > 0 && `· ~${formatTokenCount(estimatedTokens)} tokens`}
            </span>
          </>
        ) : block.startedAtMs != null && block.endedAtMs != null ? (
          <>
            <span className="codicon codicon-sparkle text-[11px]" />
            <span>Thought for {formatDuration(block.endedAtMs - block.startedAtMs)}</span>
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
  return startedAtMs == null ? null : Math.max(0, Math.round((now - startedAtMs) / 1000));
}

/** Rotates through THINKING_VERBS while `live`; holds still (and hides) otherwise. */
function useThinkingVerb(live: boolean): string {
  const [i, setI] = useState(() => Math.floor(Math.random() * THINKING_VERBS.length));
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setI((v) => (v + 1) % THINKING_VERBS.length), 2000);
    return () => clearInterval(id);
  }, [live]);
  return THINKING_VERBS[i] ?? "Thinking";
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
  onDecide: (d: "allow" | "deny", updatedInput?: Record<string, unknown>) => void;
}) {
  const askQuestion = parseAskUserQuestion(perm.toolName, perm.toolInput);
  const plan = askQuestion == null ? parsePlan(perm.toolName, perm.toolInput) : null;
  const editView = plan == null && askQuestion == null ? parseEditView(perm.toolName, perm.toolInput) : null;
  const todos =
    plan == null && askQuestion == null && perm.toolName === "TodoWrite" ? parseTodos(perm.toolInput) : null;

  if (askQuestion != null) {
    return (
      <AskUserQuestionCard
        view={askQuestion}
        canAct={canAct}
        onSubmit={(answers) =>
          onDecide("allow", { ...(perm.toolInput as Record<string, unknown>), answers })
        }
        onCancel={() => onDecide("deny")}
      />
    );
  }

  return (
    <div className="crc-enter rounded-xl border border-(--crc-warning)/40 bg-(--crc-warning)/8 p-4 shadow-(--crc-shadow-md)">
      <div className="flex items-center gap-2.5 text-sm text-(--crc-fg)">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-(--crc-warning)/15 text-(--crc-warning)">
          <span className={`codicon ${plan != null ? "codicon-checklist" : "codicon-shield"}`} />
        </span>
        {plan != null ? (
          <span className="font-medium">Plan ready for review</span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-1.5">
            <span className="font-medium">Claude wants to run</span>
            <span className="rounded-md bg-(--crc-surface) px-1.5 py-0.5 font-mono text-xs ring-1 ring-(--crc-border) ring-inset">{perm.toolName}</span>
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
        <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-(--crc-bg-inset)/70 px-3 py-2 font-mono text-xs leading-relaxed text-(--crc-fg-muted)">
          {truncate(JSON.stringify(perm.toolInput, null, 2), 500)}
        </pre>
      )}
      {canAct ? (
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={() => onDecide("allow")}>
            <span className="codicon codicon-check" /> {plan != null ? "Approve plan" : "Allow"}
          </Button>
          <Button variant="danger" onClick={() => onDecide("deny")}>
            <span className="codicon codicon-close" /> {plan != null ? "Keep planning" : "Deny"}
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-xs text-(--crc-fg-muted)">Only the controller can respond.</div>
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
  const [selected, setSelected] = useState<string[][]>(() => view.questions.map(() => []));
  const [otherText, setOtherText] = useState<string[]>(() => view.questions.map(() => ""));

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
    return !sel.includes(OTHER_OPTION) || (otherText[i]?.trim().length ?? 0) > 0;
  });

  function handleSubmit(): void {
    const answers: Record<string, string> = {};
    view.questions.forEach((q, i) => {
      const labels = (selected[i] ?? []).map((l) => (l === OTHER_OPTION ? (otherText[i]?.trim() ?? "") : l));
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
          <Button variant="primary" disabled={!allAnswered} onClick={handleSubmit}>
            <span className="codicon codicon-check" /> Submit answers
          </Button>
          <span className="text-xs text-(--crc-fg-muted)">Esc to cancel</span>
        </div>
      ) : (
        <div className="mt-2 text-xs text-(--crc-fg-muted)">Only the controller can respond.</div>
      )}
    </div>
  );
}

/** A picked attachment before it's sent — same wire shape as `Attachment` plus client-only bookkeeping. */
type PendingAttachment = Attachment & { id: string };

/** Reads a File into wire-format base64, or an error message if it's an unsupported type or too large. */
function readFileAsAttachment(file: File): Promise<PendingAttachment | { error: string }> {
  const mediaType = classifyAttachment(file);
  if (!mediaType) {
    return Promise.resolve({ error: `${file.name}: unsupported file type — reference it by its path in the prompt instead.` });
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Promise.resolve({ error: `${file.name}: too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB).` });
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string; // "data:<mediaType>;base64,<data>"
      const data = result.slice(result.indexOf(",") + 1);
      resolve({ id: crypto.randomUUID(), name: file.name, mediaType, data });
    };
    reader.onerror = () => resolve({ error: `${file.name}: couldn't read file.` });
    reader.readAsDataURL(file);
  });
}

/** One attached file: a thumbnail for images, a file chip otherwise. `onRemove` omitted renders it read-only (timeline history). */
function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove?: () => void }) {
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
        <span className="max-w-40 truncate text-(--crc-fg)" title={attachment.name}>
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
      {previewing && <ImagePreviewDialog attachment={attachment} onClose={() => setPreviewing(false)} />}
    </>
  );
}

/** Full-screen preview of an attached image, dismissed by backdrop click, X, or Escape. */
function ImagePreviewDialog({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
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
    opts?: { model?: string; maxThinkingTokens?: number | null; permissionMode?: PermissionModeKey; attachments?: Attachment[] },
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
  const [permissionMode, setPermissionModeState] = useState<PermissionModeKey>(loadPermissionMode);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse>({ models: [], commands: [] });
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [openMenu, setOpenMenu] = useState<"model" | "effort" | "mode" | null>(null);
  const [customModel, setCustomModel] = useState("");

  useEffect(() => {
    rest.getCapabilities().then(setCapabilities).catch(() => {});
  }, [rest]);

  // supportedModels() already includes its own "Default (recommended)" entry
  // (first in the list) — no need for our own placeholder on top of it. Once
  // the real list loads, default the selection to that entry rather than an
  // empty value that wouldn't match any <option>.
  useEffect(() => {
    if (!model && capabilities.models.length > 0) setModel(capabilities.models[0]?.value ?? "");
  }, [capabilities, model]);

  // Move focus to the composer as soon as this device gains control (whether
  // by taking it explicitly or via auto-claim on session creation).
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  const effort = EFFORT_LEVELS.find((e) => e.key === effortKey) ?? EFFORT_LEVELS[0];
  const mode = PERMISSION_MODES.find((m) => m.key === permissionMode) ?? PERMISSION_MODES[0];
  const selectedModel = capabilities.models.find((m) => m.value === model);
  const suggestions =
    text.startsWith("/") && text.length > 1 && !text.includes(" ")
      ? capabilities.commands.filter((c) => c.name.toLowerCase().startsWith(text.slice(1).toLowerCase()))
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
      attachments: attachments.length > 0 ? attachments.map(({ id: _id, ...a }) => a) : undefined,
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
      setAttachError(`Up to ${MAX_ATTACHMENTS_PER_PROMPT} attachments per message.`);
      return;
    }

    const results = await Promise.all(list.slice(0, room).map(readFileAsAttachment));
    const accepted = results.filter((r): r is PendingAttachment => !("error" in r));
    const errors = results.filter((r): r is { error: string } => "error" in r).map((r) => r.error);
    if (list.length > room) errors.push(`Only ${room} more attachment${room === 1 ? "" : "s"} allowed — dropped the rest.`);

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

  return (
    <div
      className="relative border-t border-(--crc-border)/60 bg-(--crc-bg-elevated) px-6 pb-4 pt-3"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
      }}
    >
      <div className="relative mx-auto w-full max-w-4xl">
        {suggestions.length > 0 && (
          <div className="crc-enter absolute bottom-full left-4 right-4 z-10 mb-2 max-h-48 overflow-y-auto rounded-xl border border-(--crc-border) bg-(--crc-surface) p-1 shadow-(--crc-shadow-lg)">
            {suggestions.map((c, i) => (
              <button
                key={c.name}
                onClick={() => pickSuggestion(c.name)}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs ${
                  i === suggestionIndex ? "bg-(--crc-selected) text-(--crc-selected-fg)" : "text-(--crc-fg)"
                }`}
              >
                <span className="font-mono text-(--crc-link)">/{c.name}</span>
                <span className="truncate text-(--crc-fg-muted)">{c.description}</span>
                {c.argumentHint && <span className="ml-auto shrink-0 text-(--crc-fg-muted)">{c.argumentHint}</span>}
              </button>
            ))}
          </div>
        )}


        {openMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpenMenu(null)} />
            <div
              className="crc-enter absolute bottom-full left-4 z-50 mb-2 max-h-72 w-80 overflow-y-auto rounded-xl border border-(--crc-border) bg-(--crc-surface) p-1 text-xs shadow-(--crc-shadow-lg)"
              onClick={(e) => e.stopPropagation()}
            >
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
                          <div className="truncate font-medium text-(--crc-fg)">{m.displayName}</div>
                          {m.description && <div className="truncate text-(--crc-fg-muted)">{m.description}</div>}
                        </div>
                        {m.value === model && <span className="codicon codicon-check shrink-0 text-(--crc-fg)" />}
                      </button>
                    )),
                    <div key="custom" className="mt-1 border-t border-(--crc-border)/60 p-2">
                      <div className="mb-1 text-(--crc-fg-muted)">Not listed? Enter a model ID directly:</div>
                      <div className="flex gap-1.5">
                        <input
                          value={customModel}
                          onChange={(ev) => setCustomModel(ev.target.value)}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter") useCustomModel();
                          }}
                          placeholder="claude-fable-5"
                          spellCheck={false}
                          autoComplete="off"
                          className="crc-input min-w-0 flex-1 px-2 py-1 text-xs"
                        />
                        <Button variant="default" disabled={!customModel.trim()} onClick={useCustomModel} className="shrink-0">
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
                        {e.key === effortKey && <span className="codicon codicon-check shrink-0 text-(--crc-fg)" />}
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
                          <div className="truncate text-(--crc-fg-muted)">{m.description}</div>
                        </div>
                        {m.key === permissionMode && <span className="codicon codicon-check shrink-0 text-(--crc-fg)" />}
                      </button>
                    ))}
            </div>
          </>
        )}


        <div
          className={`rounded-2xl border bg-(--crc-surface) shadow-(--crc-shadow-sm) transition-[border-color,box-shadow] duration-150 focus-within:border-(--crc-accent)/60 focus-within:ring-3 focus-within:ring-(--crc-accent)/12 ${
            dragOver ? "border-(--crc-accent) ring-3 ring-(--crc-accent)/15" : "border-(--crc-border)"
          } ${disabled ? "opacity-80" : ""}`}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {attachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} onRemove={() => removeAttachment(a.id)} />
              ))}
            </div>
          )}

          {attachError && <div className="px-4 pt-3 text-xs text-(--crc-danger)">{attachError}</div>}
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
                  setSuggestionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
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
            rows={2}
            disabled={disabled}
            placeholder={disabled ? "Watching only" : busy ? "Add to what Claude is doing… it picks this up at its next step" : "Ask Claude anything… ⏎ to send, ⇧⏎ for a new line, / for commands"}
            className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-relaxed text-(--crc-fg) outline-none placeholder:text-(--crc-fg-muted) disabled:opacity-60"
          />

          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 items-center gap-0.5">
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
              >
                <span className="codicon codicon-attach" />
              </Button>
              <span className="mx-1 h-4 w-px bg-(--crc-border)" />
                <PickerButton
                  label={
                    capabilities.models.length === 0 && !model
                      ? "Loading models…"
                      : (selectedModel?.displayName ?? model ?? "Default")
                  }
                  open={openMenu === "model"}
                  onToggle={() => setOpenMenu((v) => (v === "model" ? null : "model"))}
                />
                <PickerButton
                  label={effort?.label ?? "Medium"}
                  open={openMenu === "effort"}
                  onToggle={() => setOpenMenu((v) => (v === "effort" ? null : "effort"))}
                />
                <PickerButton
                  label={mode?.label ?? "Manual"}
                  open={openMenu === "mode"}
                  onToggle={() => setOpenMenu((v) => (v === "mode" ? null : "mode"))}
                />

            </div>
            {busy ? (
              <Button variant="danger" size="sm" onClick={onStop} title="Stop the current turn">
                <span className="codicon codicon-debug-stop" /> Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                size="icon"
                title="Send (Enter)"
                aria-label="Send"
                disabled={disabled || (!text.trim() && attachments.length === 0)}
                onClick={send}
              >
                <span className="codicon codicon-arrow-up text-base" />
              </Button>
            )}
          </div>
        </div>
        {disabled && reason && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-(--crc-fg-muted)">
            <span className="codicon codicon-lock-small" /> {reason}
          </div>
        )}
      </div>
    </div>
  );
}

function PickerButton({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`flex h-7 max-w-44 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-(--crc-hover) hover:text-(--crc-fg) ${
        open ? "bg-(--crc-hover) text-(--crc-fg)" : "text-(--crc-fg-muted)"
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
