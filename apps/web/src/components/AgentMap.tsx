import {
  agentMapOf,
  backgroundTasksOf,
  flattenAgents,
  formatDuration,
  formatModelLabel,
  formatTokenCount,
  type AgentNode,
  type BackgroundTaskView,
  type TimelineItem,
} from "@renki/client-core";
import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { revealToolUse } from "../lib/toolReveal.js";
import { Markdown } from "./Markdown.js";
import { Button } from "./ui.js";

/**
 * The header's way into the agent map: every agent the session started, and
 * any command it left running in the background. Counts what's still running
 * while anything is; hidden when the session never sent anything off.
 */
export function AgentMapButton({
  timeline,
  title,
  model,
}: {
  timeline: TimelineItem[];
  /** What the root card is called: the session's title, else its repo. */
  title: string;
  model: string | null;
}) {
  const [open, setOpen] = useState(false);
  const agents = useMemo(() => agentMapOf(timeline), [timeline]);
  const commands = useMemo(() => backgroundTasksOf(timeline).filter((t) => t.kind === "command"), [timeline]);
  const all = useMemo(() => flattenAgents(agents), [agents]);
  if (all.length === 0 && commands.length === 0) return null;
  const running =
    all.filter((a) => a.status === "running").length + commands.filter((c) => c.status === "running").length;
  const label =
    running > 0
      ? `${running} running`
      : all.length > 0
        ? `${all.length} ${all.length === 1 ? "agent" : "agents"}`
        : `${commands.length} background`;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Agent map"
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-(--renki-fg-muted) transition-colors hover:bg-(--renki-surface) hover:text-(--renki-fg)"
      >
        <span className={`codicon ${running > 0 ? "codicon-loading codicon-modifier-spin" : "codicon-type-hierarchy-sub"} text-[13px]`} />
        {label}
      </button>
      {open && (
        <AgentMapDialog
          agents={agents}
          commands={commands}
          title={title}
          model={model}
          onClose={() => setOpen(false)}
          onShowInTranscript={(path) => {
            setOpen(false);
            revealToolUse(path);
          }}
        />
      )}
    </>
  );
}

/**
 * The session as a root card with the agents it started branching off it —
 * agents' own agents indented under them — like the Claude Code extension's
 * agent map. Side by side on a wide screen, stacked on a phone.
 */
export function AgentMapDialog({
  agents,
  commands,
  title,
  model,
  onClose,
  onShowInTranscript,
}: {
  agents: AgentNode[];
  commands: BackgroundTaskView[];
  title: string;
  model: string | null;
  onClose: () => void;
  /** `path` runs from the outermost agent down to the one clicked. */
  onShowInTranscript: (path: string[]) => void;
}) {
  const titleId = useId();
  const count = useMemo(() => flattenAgents(agents).length, [agents]);
  const anyRunning = useMemo(() => flattenAgents(agents).some((a) => a.status === "running"), [agents]);
  const now = useNow(anyRunning);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const tree = (nodes: AgentNode[], ancestors: string[], topLevel: boolean) => (
    <ul className={topLevel ? "ml-4 sm:ml-0" : "ml-4"}>
      {nodes.map((n, i) => {
        const first = i === 0;
        const last = i === nodes.length - 1;
        const path = [...ancestors, n.toolUseId];
        return (
          <li key={n.toolUseId} className="relative pt-2 pl-5">
            {/* The trunk down the left of the list: from the first card's
                junction (or the parent's card, when stacked under it) to the
                last card's. */}
            <span
              aria-hidden
              className={`absolute left-0 border-l border-(--renki-border) ${
                first && topLevel ? "top-0 sm:top-[26px]" : "top-0"
              } ${last ? "h-[26px]" : "bottom-0"} ${first && last && topLevel ? "sm:hidden" : ""}`}
            />
            <span aria-hidden className="absolute top-[26px] left-0 w-5 border-t border-(--renki-border)" />
            <AgentCard
              node={n}
              now={now}
              expanded={expanded === n.toolUseId}
              onToggle={() => setExpanded((cur) => (cur === n.toolUseId ? null : n.toolUseId))}
              onShowInTranscript={() => onShowInTranscript(path)}
            />
            {n.children.length > 0 && tree(n.children, path, false)}
          </li>
        );
      })}
    </ul>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="renki-enter flex max-h-[80vh] w-full max-w-3xl flex-col rounded-xl border border-(--renki-border) bg-(--renki-surface) shadow-(--renki-shadow-md)"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[15px] font-medium tracking-tight text-(--renki-fg)">
              Agent map
            </h2>
            <p className="mt-0.5 text-xs text-(--renki-fg-muted)">
              {count > 0
                ? `${count} ${count === 1 ? "agent" : "agents"} · click an agent for details`
                : "No agents yet"}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close" aria-label="Close" className="-mr-2 -mt-1">
            <span className="codicon codicon-close" />
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 pb-5">
          {agents.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-start">
              <div className="relative shrink-0 sm:mr-6 sm:w-52 sm:pt-2">
                <div className="rounded-lg border border-(--renki-border) bg-(--renki-bg-inset)/60 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="codicon codicon-comment-discussion text-[13px] text-(--renki-fg-muted)" />
                    <span className="min-w-0 truncate text-[13px] font-medium text-(--renki-fg)" title={title}>
                      {title}
                    </span>
                  </div>
                  {model && <div className="mt-0.5 truncate pl-[21px] text-xs text-(--renki-fg-muted)">{formatModelLabel(model)}</div>}
                </div>
                {/* Root → trunk, side by side only. */}
                <span aria-hidden className="absolute top-[26px] left-full hidden w-6 border-t border-(--renki-border) sm:block" />
              </div>
              <div className="min-w-0 flex-1">{tree(agents, [], true)}</div>
            </div>
          )}
          {commands.length > 0 && (
            <div className={agents.length > 0 ? "mt-5 border-t border-(--renki-border) pt-3" : ""}>
              <div className="px-2.5 pb-1 text-[11px] font-medium text-(--renki-fg-muted)">Background commands</div>
              <div className="text-xs">
                {commands.map((t) => (
                  <BackgroundTaskRow key={t.toolUseId} task={t} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** "Explore · 5m 55s · 57.7k tokens", leaving out whatever isn't known yet. */
export function agentMeta(node: AgentNode, now: number): string {
  const durationMs =
    node.usage?.durationMs ?? (node.status === "running" && node.startedAtMs != null ? now - node.startedAtMs : null);
  return [
    node.type,
    durationMs != null ? formatDuration(Math.max(0, durationMs)) : null,
    node.usage ? `${formatTokenCount(node.usage.tokens)} tokens` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const STATUS_DOT: Record<AgentNode["status"], { className: string; title: string }> = {
  running: { className: "bg-(--renki-success) animate-pulse", title: "Running" },
  done: { className: "bg-(--renki-fg-muted)", title: "Done" },
  failed: { className: "bg-(--renki-danger)", title: "Failed" },
  stopped: { className: "border border-(--renki-fg-muted)", title: "Stopped" },
};

function AgentCard({
  node,
  now,
  expanded,
  onToggle,
  onShowInTranscript,
}: {
  node: AgentNode;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onShowInTranscript: () => void;
}) {
  const dot = STATUS_DOT[node.status];
  return (
    <div
      data-testid="agent-card"
      className={`rounded-lg border bg-(--renki-surface) transition-colors ${
        expanded ? "border-(--renki-fg-muted)/40" : "border-(--renki-border) hover:bg-(--renki-hover)"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2.5 px-3 py-2 text-left"
      >
        <span
          className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${dot.className}`}
          title={dot.title}
          aria-label={dot.title}
          role="img"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={`${expanded ? "" : "truncate"} text-[13px] text-(--renki-fg)`}>{node.label}</span>
            {node.background && (
              <span className="shrink-0 rounded px-1 text-[10.5px] text-(--renki-fg-muted) ring-1 ring-(--renki-border) ring-inset">
                background
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-(--renki-fg-muted)">{agentMeta(node, now)}</span>
        </span>
        <span className={`codicon ${expanded ? "codicon-chevron-down" : "codicon-chevron-right"} mt-0.5 shrink-0 text-[12px] text-(--renki-fg-muted)`} />
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-(--renki-border) px-3 py-2.5 text-xs">
          {node.usage && (
            <div className="text-(--renki-fg-muted)">
              {node.usage.toolUses} {node.usage.toolUses === 1 ? "tool call" : "tool calls"}
            </div>
          )}
          {node.summary ? (
            <div className="max-h-64 overflow-y-auto rounded-md bg-(--renki-bg-inset)/60 px-3 py-2 text-[13px]">
              <Markdown content={node.summary} />
            </div>
          ) : (
            <div className="text-(--renki-fg-muted)">{node.status === "running" ? "Still working — no answer yet." : "No answer."}</div>
          )}
          <Button size="sm" onClick={onShowInTranscript}>
            <span className="codicon codicon-go-to-file text-[12px]" />
            Show in transcript
          </Button>
        </div>
      )}
    </div>
  );
}

/** The current time, ticking each second only while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

/** One backgrounded command, opening to its outcome. */
export function BackgroundTaskRow({ task }: { task: BackgroundTaskView }) {
  const [open, setOpen] = useState(false);
  const icon =
    task.status === "running"
      ? "codicon-loading codicon-modifier-spin text-(--renki-fg-muted)"
      : task.status === "completed"
        ? "codicon-pass-filled text-(--renki-success)"
        : task.status === "stopped"
          ? "codicon-debug-stop text-(--renki-fg-muted)"
          : "codicon-error text-(--renki-danger)";
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      disabled={!task.summary}
      className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left enabled:hover:bg-(--renki-hover)"
    >
      <span className={`codicon mt-0.5 shrink-0 ${icon}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={`${open ? "" : "truncate"} text-(--renki-fg)`}>{task.label}</span>
          <span className="shrink-0 text-[10.5px] text-(--renki-fg-muted)">{task.kind === "agent" ? "agent" : "command"}</span>
        </span>
        {task.status === "running" ? (
          <span className="block text-(--renki-fg-muted)">No result yet</span>
        ) : (
          task.summary && <span className={`block text-(--renki-fg-muted) ${open ? "whitespace-pre-wrap" : "truncate"}`}>{task.summary}</span>
        )}
      </span>
    </button>
  );
}
