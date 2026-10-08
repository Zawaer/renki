import type { ExportFormat } from "@renki/protocol";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useClient } from "../lib/client.js";
import { Button } from "./ui.js";

type Choices = { format: ExportFormat; media: boolean; tools: boolean; thinking: boolean; stats: boolean };

const DEFAULTS: Choices = { format: "markdown", media: true, tools: true, thinking: false, stats: false };
const STORAGE_KEY = "renki.export.choices";

/** The last export's choices on this device — a convenience, so it can fail quietly. */
function loadChoices(): Choices {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}
function saveChoices(c: Choices): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* private mode, blocked storage */
  }
}

/**
 * Export one chat: Markdown (a .md, or a .zip with its media) or PDF, with
 * what to include. The daemon builds the file, so the phone's export is
 * the same; this just asks and downloads.
 */
export function ExportDialog({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }) {
  const { rest } = useClient();
  const [choices, setChoices] = useState<Choices>(loadChoices);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = <K extends keyof Choices>(k: K, v: Choices[K]) => setChoices((c) => ({ ...c, [k]: v }));

  async function run() {
    setBusy(true);
    setError(null);
    saveChoices(choices);
    try {
      const file = await rest.exportSession(sessionId, choices);
      const url = URL.createObjectURL(new Blob([file.data], { type: file.contentType }));
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="renki-enter w-full max-w-sm rounded-xl border border-(--renki-border) bg-(--renki-surface) p-5 shadow-(--renki-shadow-md)"
      >
        <h2 id={titleId} className="text-[15px] font-medium tracking-tight text-(--renki-fg)">
          Export chat
        </h2>
        <p className="mt-0.5 truncate text-xs text-(--renki-fg-muted)">{title}</p>

        <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-(--renki-bg-inset) p-1" role="radiogroup" aria-label="Format">
          {(["markdown", "pdf"] as const).map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={choices.format === f}
              onClick={() => set("format", f)}
              className={`rounded-md py-1.5 text-[13px] transition-colors ${
                choices.format === f ? "bg-(--renki-surface) font-medium text-(--renki-fg) shadow-(--renki-shadow-xs)" : "text-(--renki-fg-muted) hover:text-(--renki-fg)"
              }`}
            >
              {f === "markdown" ? "Markdown" : "PDF"}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-2.5">
          <Check
            label="Include media"
            hint={choices.format === "markdown" ? "Images and files go in a .zip beside the .md" : "Images appear in the PDF"}
            checked={choices.media}
            onChange={(v) => set("media", v)}
          />
          <Check label="Include tool calls" hint="Commands Claude ran, files it edited, and their output" checked={choices.tools} onChange={(v) => set("tools", v)} />
          <Check label="Include thinking" hint="Claude's reasoning, where it was shown" checked={choices.thinking} onChange={(v) => set("thinking", v)} />
          <Check label="Include stats" hint="Each reply's duration, tokens and cost" checked={choices.stats} onChange={(v) => set("stats", v)} />
        </div>

        {error && <p className="mt-3 text-xs text-(--renki-danger)">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            {busy ? (
              <>
                <span className="codicon codicon-loading codicon-modifier-spin" /> Exporting…
              </>
            ) : (
              <>
                <span className="codicon codicon-desktop-download" /> Export
              </>
            )}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Check({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-(--renki-accent)" />
      <span>
        <span className="block text-[13px] text-(--renki-fg)">{label}</span>
        <span className="block text-[11.5px] text-(--renki-fg-muted)">{hint}</span>
      </span>
    </label>
  );
}
