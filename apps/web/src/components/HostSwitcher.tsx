import { setActiveHost } from "@renki/client-core";
import { useState } from "react";
import { loadHosts, saveHosts } from "../lib/hosts.js";
import { AddHostModal } from "./AddHostModal.js";

/**
 * The sidebar header, doubling as a switcher between stored daemons. Always
 * interactive, even with only one host on record — that's the discoverable
 * path to "add another host" (a Mac for local work, say, alongside the
 * always-on server), not just a per-host affordance that only appears once
 * you already have two.
 */
export function HostSwitcher() {
  const [state, setState] = useState(loadHosts);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const active = state.hosts.find((h) => h.id === state.activeId);

  function switchTo(id: string) {
    setOpen(false);
    if (id === state.activeId) return;
    saveHosts(setActiveHost(state, id));
    window.location.reload();
  }

  return (
    <div className="relative min-w-0 flex-1">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left hover:bg-(--renki-hover)"
        title="Switch daemon"
      >
        <span className="truncate text-[13px] font-semibold tracking-tight text-(--renki-fg)">{active?.label ?? "Renki"}</span>
        <span className="codicon codicon-chevron-down shrink-0 text-[10px] text-(--renki-fg-muted)" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="renki-enter absolute top-full left-0 z-50 mt-1 w-56 overflow-hidden rounded-xl border border-(--renki-border) bg-(--renki-surface) p-1 text-sm shadow-(--renki-shadow-lg)"
            onClick={(e) => e.stopPropagation()}
          >
            {state.hosts.map((h) => (
              <button
                key={h.id}
                onClick={() => switchTo(h.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-(--renki-hover)"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${h.id === state.activeId ? "bg-(--renki-success)" : "bg-transparent"}`} />
                <span className={`min-w-0 flex-1 truncate ${h.id === state.activeId ? "text-(--renki-fg)" : "text-(--renki-fg-muted)"}`}>
                  {h.label}
                </span>
              </button>
            ))}
            <div className="my-1 h-px bg-(--renki-border)" />
            <button
              onClick={() => {
                setOpen(false);
                setAdding(true);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-(--renki-fg-muted) hover:bg-(--renki-hover) hover:text-(--renki-fg)"
            >
              <span className="codicon codicon-add shrink-0 text-[13px]" />
              Add another host
            </button>
          </div>
        </>
      )}

      {adding && <AddHostModal state={state} onClose={() => setAdding(false)} />}
    </div>
  );
}
