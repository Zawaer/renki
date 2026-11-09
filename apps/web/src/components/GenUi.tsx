import { createContext, useContext, useState } from "react";
import { choiceReply, type UiBlock, type UiChecklist, type UiChoices, type UiStats } from "@renki/client-core";

/**
 * Generative UI: the components an agent can put in a reply with a
 * ```renki-ui block (format and phone fallback in client-core's genui.ts).
 * Markdown's `pre` renderer hands a parsed block here.
 */

/**
 * Sends a picked choice as the user's message. Provided by SessionView around
 * the transcript; with no provider (a Markdown viewer outside a chat, an
 * archived chat) choices show but can't be picked.
 */
export const GenUiReplyContext = createContext<((text: string) => void) | null>(null);

export function GenUi({ block }: { block: UiBlock }) {
  switch (block.type) {
    case "choices":
      return <Choices block={block} />;
    case "checklist":
      return <Checklist block={block} />;
    case "stats":
      return <Stats block={block} />;
  }
}

/** Shown in place of a block while it's still streaming in. */
export function GenUiPending() {
  return <div className="h-16 animate-pulse rounded-xl border border-(--renki-border) bg-(--renki-surface)" aria-label="Loading" />;
}

const frame = "rounded-xl border border-(--renki-border) bg-(--renki-surface) px-4 py-3";

function Choices({ block }: { block: UiChoices }) {
  const onReply = useContext(GenUiReplyContext);
  /** Picked here, this page load: the rest dim so it's clear what was sent. */
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div className={frame} data-testid="genui-choices">
      {block.question && <div className="mb-2.5 text-[14px] font-medium text-(--renki-fg)">{block.question}</div>}
      <div className="flex flex-col gap-1.5">
        {block.options.map((o, i) => (
          <button
            key={i}
            type="button"
            disabled={!onReply || picked !== null}
            onClick={() => {
              setPicked(i);
              onReply?.(choiceReply(o));
            }}
            title={onReply ? "Send" : undefined}
            className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-default ${
              picked === i
                ? "border-(--renki-accent) bg-(--renki-selected)"
                : "border-(--renki-border) bg-(--renki-bg) enabled:hover:bg-(--renki-hover)"
            } ${picked !== null && picked !== i ? "opacity-50" : ""}`}
          >
            <div className="text-[13.5px] text-(--renki-fg)">{o.label}</div>
            {o.detail && <div className="mt-0.5 text-xs text-(--renki-fg-muted)">{o.detail}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

function Checklist({ block }: { block: UiChecklist }) {
  const done = block.items.filter((i) => i.done).length;
  return (
    <div className={frame} data-testid="genui-checklist">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="text-[14px] font-medium text-(--renki-fg)">{block.title ?? "Checklist"}</div>
        <div className="text-xs tabular-nums text-(--renki-fg-muted)">
          {done} of {block.items.length}
        </div>
      </div>
      <div className="mb-3 h-1 overflow-hidden rounded-full bg-(--renki-bg-inset)">
        <div className="h-full rounded-full bg-(--renki-success) transition-[width]" style={{ width: `${(done / block.items.length) * 100}%` }} />
      </div>
      <ul className="space-y-1.5">
        {block.items.map((it, i) => (
          <li key={i} className="flex gap-2.5">
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                it.done ? "border-(--renki-success) bg-(--renki-success) text-(--renki-bg)" : "border-(--renki-border)"
              }`}
              aria-label={it.done ? "Done" : "Not done"}
            >
              {it.done && <span className="codicon codicon-check text-[11px]" />}
            </span>
            <div className="min-w-0">
              <div className={`text-[13.5px] ${it.done ? "text-(--renki-fg-muted)" : "text-(--renki-fg)"}`}>{it.text}</div>
              {it.detail && <div className="text-xs text-(--renki-fg-muted)">{it.detail}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stats({ block }: { block: UiStats }) {
  return (
    <div data-testid="genui-stats">
      {block.title && <div className="mb-2 text-[14px] font-medium text-(--renki-fg)">{block.title}</div>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
        {block.items.map((s, i) => (
          <div key={i} className={frame}>
            <div className="text-xs text-(--renki-fg-muted)">{s.label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-(--renki-fg)">{s.value}</div>
            {s.note && <div className="mt-0.5 text-xs text-(--renki-fg-muted)">{s.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
