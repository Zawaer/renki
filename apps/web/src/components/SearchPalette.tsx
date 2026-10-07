import { formatHitTime, groupSearchHits, searchHitAnchor, splitSnippet, type SearchGroup } from "@renki/client-core";
import type { SearchHit, SearchResponse } from "@renki/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useClient } from "../lib/client.js";

/** How many hits a chat shows before its "more" row. */
const PER_CHAT = 3;
const DEBOUNCE_MS = 180;

/**
 * Search everything said in every chat — your prompts and Claude's replies,
 * not just titles. Opened with ⌘K or the sidebar's search button. Picking a
 * hit opens that chat scrolled to the message, with the match highlighted
 * (`at` and `q` on the session URL; SessionView does the scrolling).
 */
export function SearchPalette({ onClose, onOpen }: { onClose: () => void; onOpen: (sessionId: string, anchor: string, query: string) => void }) {
  const { rest } = useClient();
  const [query, setQuery] = useState(lastQuery);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    lastQuery = query;
    const q = query.trim();
    if (!q) {
      setResult(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      rest
        .search(q)
        .then((r) => {
          if (cancelled) return;
          setResult(r);
          setFailed(false);
          setExpanded(new Set());
          setActive(0);
        })
        .catch(() => !cancelled && setFailed(true))
        .finally(() => !cancelled && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, rest]);

  const groups = useMemo(() => (result ? groupSearchHits(result.hits) : []), [result]);
  // The rows the arrow keys walk, in screen order.
  const visible = useMemo(
    () => groups.flatMap((g) => (expanded.has(g.sessionId) ? g.hits : g.hits.slice(0, PER_CHAT))),
    [groups, expanded],
  );

  function open(hit: SearchHit) {
    onOpen(hit.sessionId, searchHitAnchor(hit), result?.query ?? query.trim());
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (visible.length === 0) return;
      const next = (active + (e.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
      setActive(next);
      listRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = visible[active];
      if (hit) open(hit);
    }
  }

  const q = query.trim();
  let row = 0;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search chats"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="renki-enter flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-(--renki-border) bg-(--renki-surface) shadow-(--renki-shadow-md)"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-(--renki-border) px-4">
          <span
            className={`codicon ${loading ? "codicon-loading codicon-modifier-spin" : "codicon-search"} text-(--renki-fg-muted)`}
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all chats"
            aria-label="Search all chats"
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-(--renki-fg) outline-none placeholder:text-(--renki-fg-muted)"
          />
          <kbd className="rounded border border-(--renki-border) px-1.5 py-0.5 text-[10px] text-(--renki-fg-muted)">esc</kbd>
        </div>

        <div ref={listRef} className="min-h-0 overflow-y-auto">
          {!q && <Hint>Search what you and Claude said in every chat — any word, path or bit of code.</Hint>}
          {q && failed && <Hint>Couldn't search — is the daemon reachable?</Hint>}
          {q && !failed && result && result.query === q && groups.length === 0 && <Hint>Nothing found for “{q}”.</Hint>}
          {groups.length > 0 && (
            <div className="py-1.5">
              {groups.map((g) => {
                const shown = expanded.has(g.sessionId) ? g.hits : g.hits.slice(0, PER_CHAT);
                return (
                  <div key={g.sessionId} className="px-1.5 pb-1.5">
                    <GroupHeader group={g} />
                    {shown.map((hit) => {
                      const index = row++;
                      return (
                        <HitRow
                          key={`${hit.sessionId}:${hit.seq}`}
                          hit={hit}
                          index={index}
                          active={index === active}
                          onHover={() => setActive(index)}
                          onOpen={() => open(hit)}
                        />
                      );
                    })}
                    {shown.length < g.hits.length && (
                      <button
                        onClick={() => {
                          setExpanded((prev) => new Set(prev).add(g.sessionId));
                          inputRef.current?.focus();
                        }}
                        className="ml-9 rounded px-1.5 py-0.5 text-[11.5px] text-(--renki-fg-muted) hover:bg-(--renki-hover) hover:text-(--renki-fg)"
                      >
                        {g.hits.length - shown.length} more in this chat
                      </button>
                    )}
                  </div>
                );
              })}
              {result?.truncated && (
                <div className="px-4 pt-1 pb-2 text-[11.5px] text-(--renki-fg-muted)">
                  Showing the newest {result.hits.length} matches — add more words to narrow it down.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Kept across openings, so ⌘K brings back what you were looking for. */
let lastQuery = "";

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-center text-[13px] text-(--renki-fg-muted)">{children}</div>;
}

function GroupHeader({ group }: { group: SearchGroup }) {
  return (
    <div className="flex items-baseline gap-2 px-2.5 pt-2 pb-1">
      <span className="truncate text-[12.5px] font-medium text-(--renki-fg)">{group.title}</span>
      {group.repoName && <span className="shrink-0 text-[11px] text-(--renki-fg-muted)">{group.repoName}</span>}
    </div>
  );
}

function HitRow({ hit, index, active, onHover, onOpen }: { hit: SearchHit; index: number; active: boolean; onHover: () => void; onOpen: () => void }) {
  const [before, match, after] = splitSnippet(hit);
  return (
    <button
      data-row={index}
      onMouseMove={onHover}
      onClick={onOpen}
      className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left ${active ? "bg-(--renki-hover)" : ""}`}
    >
      <span
        title={hit.role === "you" ? "You" : "Claude"}
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-(--renki-bg-inset) text-(--renki-fg-muted)"
      >
        <span className={`codicon codicon-${hit.role === "you" ? "account" : "sparkle"} text-[12px]`} />
      </span>
      <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug text-(--renki-fg-muted)">
        {before}
        <mark className="rounded-sm bg-(--renki-accent)/25 px-px text-(--renki-fg)">{match}</mark>
        {after}
      </span>
      <span className="mt-0.5 shrink-0 text-[11px] text-(--renki-fg-muted)">{formatHitTime(hit.ts)}</span>
    </button>
  );
}
