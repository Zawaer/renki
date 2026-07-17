import type { BlockView, PermissionView, TimelineItem, TurnView } from "@crc/client-core";
import { useEffect, useRef, useState } from "react";
import { useClient, useStoreValue } from "../lib/client.js";
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
      <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-neutral-200">
            {conv.repoName ?? "…"} <span className="text-neutral-500">:{conv.branch ?? ""}</span>
          </div>
          <div className="text-xs text-neutral-500">
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
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {conv.timeline.length === 0 && (
          <p className="text-sm text-neutral-500">No messages yet. Take control and send a prompt.</p>
        )}
        {conv.timeline.map((item, i) => (
          <TimelineRow key={i} item={item} />
        ))}
      </div>

      {/* Pending permissions */}
      {conv.pending.length > 0 && (
        <div className="space-y-2 border-t border-neutral-800 bg-neutral-900/40 p-3">
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
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-indigo-600 px-3.5 py-2 text-sm text-white">
          {item.text}
        </div>
      </div>
    );
  }
  return <AssistantTurn turn={item.turn} />;
}

function AssistantTurn({ turn }: { turn: TurnView }) {
  return (
    <div className="space-y-2">
      {turn.blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
      {turn.status === "running" && <span className="inline-block h-4 w-2 animate-pulse bg-neutral-400 align-middle" />}
      {turn.status === "done" && turn.costUsd != null && (
        <div className="text-[11px] text-neutral-600">
          ${turn.costUsd.toFixed(4)} · {turn.durationMs}ms
        </div>
      )}
      {turn.status === "error" && <div className="text-xs text-red-400">Turn failed: {turn.errorMessage}</div>}
    </div>
  );
}

function Block({ block }: { block: BlockView }) {
  if (block.kind === "tool_use") {
    return (
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 text-xs">
        <div className="flex items-center gap-2 px-3 py-1.5 font-mono text-neutral-300">
          <span className="text-amber-400">⚙</span>
          {block.toolName}
        </div>
        <pre className="overflow-x-auto border-t border-neutral-800 px-3 py-1.5 font-mono text-neutral-400">
          {truncate(JSON.stringify(block.toolInput, null, 2), 800)}
        </pre>
        {block.result && (
          <pre
            className={`overflow-x-auto border-t border-neutral-800 px-3 py-1.5 font-mono ${
              block.result.ok ? "text-neutral-500" : "text-red-400"
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
    return <div className="whitespace-pre-wrap border-l-2 border-neutral-700 pl-3 text-sm italic text-neutral-500">{block.text}</div>;
  }
  return <div className="whitespace-pre-wrap text-sm text-neutral-200">{block.text}</div>;
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
    <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-3">
      <div className="text-sm text-amber-200">
        Permission requested: <span className="font-mono">{perm.toolName}</span>
      </div>
      <pre className="mt-1 max-h-24 overflow-auto text-xs text-neutral-400">{truncate(JSON.stringify(perm.toolInput, null, 2), 500)}</pre>
      {canAct ? (
        <div className="mt-2 flex gap-2">
          <Button variant="primary" onClick={() => onDecide("allow")}>
            Allow
          </Button>
          <Button variant="danger" onClick={() => onDecide("deny")}>
            Deny
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-xs text-neutral-500">Only the controller can respond.</div>
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
    <div className="border-t border-neutral-800 p-3">
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
          className="flex-1 resize-none rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-indigo-600 disabled:opacity-50"
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
