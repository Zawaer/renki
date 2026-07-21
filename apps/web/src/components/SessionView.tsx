import { THINKING_VERBS, type BlockView, type PermissionView, type TimelineItem, type TurnView } from "@crc/client-core";
import { useEffect, useRef, useState } from "react";
import { useClient, useStoreValue } from "../lib/client.js";
import { hostOpenFile, isHosted } from "../lib/host.js";
import { Markdown } from "./Markdown.js";
import { Button, StatusBadge } from "./ui.js";

export function SessionView({ sessionId }: { sessionId: string }) {
  const { realtime, rest, config } = useClient();
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
      <div className="flex items-center justify-between gap-3 border-b border-(--crc-border) px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-(--crc-fg)">
            {conv.repoName ?? "…"} <span className="text-(--crc-fg-muted)">:{conv.branch ?? ""}</span>
          </div>
          <div className="text-xs text-(--crc-fg-muted)">
            {conv.controller
              ? isController
                ? "You're in control"
                : `Controlled by ${conv.controllerName ?? conv.controller}`
              : "Unlocked"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          {isController ? (
            <Button onClick={() => realtime.releaseControl(sessionId)}>Release</Button>
          ) : (
            <Button variant="primary" onClick={() => realtime.takeControl(sessionId)}>
              Take control
            </Button>
          )}
          {status !== "archived" && (
            <Button variant="danger" onClick={() => void rest.archiveSession(sessionId)}>
              Archive
            </Button>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {conv.timeline.length === 0 && (
          <p className="text-sm text-(--crc-fg-muted)">No messages yet. Take control and send a prompt.</p>
        )}
        {conv.timeline.map((item, i) => (
          <TimelineRow key={i} item={item} />
        ))}
      </div>

      {/* Pending permissions */}
      {conv.pending.length > 0 && (
        <div className="space-y-2 border-t border-(--crc-border) bg-(--crc-bg-elevated) p-3">
          {conv.pending.map((p) => (
            <PermissionCard
              key={p.requestId}
              perm={p}
              canAct={isController}
              onDecide={(d) => realtime.resolvePermission(sessionId, p.requestId, d)}
            />
          ))}
        </div>
      )}

      <Composer
        disabled={!isController || status === "busy"}
        reason={!isController ? "Take control to send prompts" : status === "busy" ? "Claude is working…" : ""}
        onSend={(text) => realtime.submitPrompt(sessionId, text)}
      />
    </div>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  if (item.type === "prompt") {
    return (
      <div className="flex gap-2 border-l-2 border-(--crc-accent) bg-(--crc-bg-elevated) px-3 py-2">
        <span className="codicon codicon-account mt-0.5 text-(--crc-accent)" />
        <div className="whitespace-pre-wrap text-sm text-(--crc-fg)">{item.text}</div>
      </div>
    );
  }
  if (item.type === "notice") {
    return (
      <div className="flex justify-center">
        <span
          className={`inline-flex items-center gap-1 rounded-sm px-3 py-1 text-xs ${
            item.level === "warn" ? "bg-(--crc-warning)/15 text-(--crc-warning)" : "bg-(--crc-bg-elevated) text-(--crc-fg-muted)"
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
  return (
    <div className="space-y-2">
      {turn.blocks.map((b, i) => (
        <Block key={i} block={b} turnRunning={turn.status === "running"} />
      ))}
      {turn.status === "running" && (
        <span className="codicon codicon-loading codicon-modifier-spin text-(--crc-fg-muted)" />
      )}
      {turn.status === "done" && turn.costUsd != null && (
        <div className="text-[11px] text-(--crc-fg-muted)">
          ${turn.costUsd.toFixed(4)} · {turn.durationMs}ms
        </div>
      )}
      {turn.status === "error" && (
        <div className="flex items-center gap-1 text-xs text-(--crc-danger)">
          <span className="codicon codicon-error" /> Turn failed: {turn.errorMessage}
        </div>
      )}
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
    return (
      <div className="rounded-sm border border-(--crc-border) bg-(--crc-bg-elevated) text-xs">
        <div className="flex items-center gap-2 px-3 py-1.5 font-mono text-(--crc-fg)">
          <span className={`codicon codicon-${toolIcon(block.toolName)} text-(--crc-warning)`} />
          {block.toolName}
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
        <pre className="overflow-x-auto border-t border-(--crc-border) px-3 py-1.5 font-mono text-(--crc-fg-muted)">
          {truncate(JSON.stringify(block.toolInput, null, 2), 800)}
        </pre>
        {block.result && (
          <pre
            className={`overflow-x-auto border-t border-(--crc-border) px-3 py-1.5 font-mono ${
              block.result.ok ? "text-(--crc-fg-muted)" : "text-(--crc-danger)"
            }`}
          >
            {block.result.ok ? "" : "error: "}
            {truncate(block.result.summary, 800)}
          </pre>
        )}
      </div>
    );
  }
  if (block.kind === "thinking") {
    return <ThinkingBlock block={block} live={turnRunning && block.endedAtMs == null} />;
  }
  return <Markdown content={block.text} />;
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

  return (
    <div className="border-l-2 border-(--crc-border) pl-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-(--crc-fg-muted)">
        {live ? (
          <>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>
              {verb}… {elapsedSeconds != null && `· ${elapsedSeconds}s`}
            </span>
          </>
        ) : block.startedAtMs != null && block.endedAtMs != null ? (
          <span>Thought for {formatDuration(block.endedAtMs - block.startedAtMs)}</span>
        ) : (
          <span>Thinking</span>
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
  onDecide: (d: "allow" | "deny") => void;
}) {
  return (
    <div className="rounded-sm border-l-2 border-(--crc-warning) bg-(--crc-warning)/10 p-3">
      <div className="flex items-center gap-1.5 text-sm text-(--crc-warning)">
        <span className="codicon codicon-shield" />
        Permission requested: <span className="font-mono">{perm.toolName}</span>
      </div>
      <pre className="mt-1 max-h-24 overflow-auto text-xs text-(--crc-fg-muted)">
        {truncate(JSON.stringify(perm.toolInput, null, 2), 500)}
      </pre>
      {canAct ? (
        <div className="mt-2 flex gap-2">
          <Button variant="primary" onClick={() => onDecide("allow")}>
            <span className="codicon codicon-check" /> Allow
          </Button>
          <Button variant="danger" onClick={() => onDecide("deny")}>
            <span className="codicon codicon-close" /> Deny
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-xs text-(--crc-fg-muted)">Only the controller can respond.</div>
      )}
    </div>
  );
}

function Composer({
  disabled,
  reason,
  onSend,
}: {
  disabled: boolean;
  reason: string;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");

  function send() {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  }

  return (
    <div className="border-t border-(--crc-border) p-3">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          disabled={disabled}
          placeholder={disabled ? reason : "Send a prompt… (Enter to send, Shift+Enter for newline)"}
          className="flex-1 resize-none rounded-sm border border-(--crc-border) bg-(--crc-input-bg) px-3 py-2 text-sm text-(--crc-fg) outline-none placeholder:text-(--crc-fg-muted) focus:border-(--crc-focus) disabled:opacity-50"
        />
        <Button variant="primary" disabled={disabled || !text.trim()} onClick={send}>
          Send
        </Button>
      </div>
    </div>
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
