import { RestError } from "@renki/client-core";
import type { WorkspaceChangesResponse, WorkspaceDirResponse, WorkspaceFileChange, WorkspaceFileResponse } from "@renki/protocol";
import { useCallback, useEffect, useState } from "react";
import { useClient } from "../lib/client.js";
import { Markdown } from "./Markdown.js";
import { Skeleton } from "./ui.js";

export type WorkspaceTab = "changes" | "files";

/**
 * The side panel beside a session: what it has changed relative to its base
 * branch, and its working tree's files. Read-only — the point is to see what
 * Claude did without leaving the conversation or opening a terminal.
 *
 * `refreshKey` changes whenever a turn finishes, so the Changes list follows
 * the work instead of going stale.
 */
export function WorkspacePanel({
  sessionId,
  tab,
  onTab,
  onClose,
  refreshKey,
}: {
  sessionId: string;
  tab: WorkspaceTab;
  onTab: (tab: WorkspaceTab) => void;
  onClose: () => void;
  refreshKey: unknown;
}) {
  return (
    <aside
      aria-label="Session workspace"
      className="flex min-h-0 flex-col border-l border-(--renki-border) bg-(--renki-bg) max-lg:absolute max-lg:inset-0 max-lg:z-30 lg:w-[45%] lg:max-w-[44rem] lg:shrink-0"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-(--renki-border) px-3 py-2">
        <PanelTab active={tab === "changes"} onClick={() => onTab("changes")} icon="codicon-diff">
          Changes
        </PanelTab>
        <PanelTab active={tab === "files"} onClick={() => onTab("files")} icon="codicon-files">
          Files
        </PanelTab>
        <button
          type="button"
          onClick={onClose}
          title="Close panel"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-(--renki-fg-muted) hover:bg-(--renki-hover) hover:text-(--renki-fg)"
        >
          <span className="codicon codicon-close" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "changes" ? <ChangesTab sessionId={sessionId} refreshKey={refreshKey} /> : <FilesTab sessionId={sessionId} />}
      </div>
    </aside>
  );
}

function PanelTab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: string; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition-colors ${
        active ? "bg-(--renki-surface) text-(--renki-fg)" : "text-(--renki-fg-muted) hover:text-(--renki-fg)"
      }`}
    >
      <span className={`codicon ${icon} text-[13px]`} />
      {children}
    </button>
  );
}

/** What to say when a workspace request fails — most often a daemon that predates these endpoints. */
function failureText(err: unknown): string {
  // An unknown route on an older daemon: Fastify's own 404, not one of ours.
  if (err instanceof RestError && err.status === 404 && err.code !== "not_found" && err.code !== "no_worktree") {
    return "This needs a newer daemon — it will work once the daemon is updated.";
  }
  if (err instanceof RestError && err.code === "no_worktree") return "This session has no working tree anymore.";
  return err instanceof Error ? err.message : "Couldn't load this.";
}

const STATUS_STYLE: Record<WorkspaceFileChange["status"], { label: string; tone: string; title: string }> = {
  A: { label: "A", tone: "text-(--renki-success)", title: "Added" },
  M: { label: "M", tone: "text-(--renki-warning)", title: "Modified" },
  D: { label: "D", tone: "text-(--renki-danger)", title: "Deleted" },
  T: { label: "T", tone: "text-(--renki-fg-muted)", title: "Type changed" },
  "?": { label: "U", tone: "text-(--renki-success)", title: "Untracked (new, not yet committed)" },
};

function ChangesTab({ sessionId, refreshKey }: { sessionId: string; refreshKey: unknown }) {
  const { rest } = useClient();
  const [data, setData] = useState<WorkspaceChangesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);

  const load = useCallback(() => {
    rest
      .getWorkspaceChanges(sessionId)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(failureText(err)));
  }, [rest, sessionId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (error) return <PanelNote>{error}</PanelNote>;
  if (!data) return <PanelSkeleton />;
  if (!data.available) return <PanelNote>This session isn't in a git repository, so there's nothing to compare.</PanelNote>;

  const added = data.files.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = data.files.reduce((n, f) => n + (f.removed ?? 0), 0);
  return (
    <div className="text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-(--renki-fg-muted)">
        <span className="font-mono text-(--renki-fg)">{data.base ?? "HEAD"}</span>
        <span className="codicon codicon-arrow-right text-[11px]" />
        <span className="font-mono text-(--renki-fg)">{data.branch ?? "working tree"}</span>
        <span>·</span>
        <span>
          {data.files.length} {data.files.length === 1 ? "file" : "files"}
        </span>
        {(added > 0 || removed > 0) && (
          <span className="font-mono">
            <span className="text-(--renki-success)">+{added}</span> <span className="text-(--renki-danger)">−{removed}</span>
          </span>
        )}
        {data.ahead > 0 && (
          <span>
            · {data.ahead} {data.ahead === 1 ? "commit" : "commits"}
          </span>
        )}
        <button
          type="button"
          onClick={load}
          title="Refresh"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md hover:bg-(--renki-hover) hover:text-(--renki-fg)"
        >
          <span className="codicon codicon-refresh text-[12px]" />
        </button>
      </div>
      {data.files.length === 0 ? (
        <PanelNote>No changes yet — the working tree matches {data.base ?? "HEAD"}.</PanelNote>
      ) : (
        <div className="border-t border-(--renki-border)/60">
          {data.files.map((f) => (
            <ChangedFile
              key={f.path}
              sessionId={sessionId}
              file={f}
              open={openPath === f.path}
              onToggle={() => setOpenPath(openPath === f.path ? null : f.path)}
              refreshKey={refreshKey}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChangedFile({
  sessionId,
  file,
  open,
  onToggle,
  refreshKey,
}: {
  sessionId: string;
  file: WorkspaceFileChange;
  open: boolean;
  onToggle: () => void;
  refreshKey: unknown;
}) {
  const { rest } = useClient();
  const [patch, setPatch] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const style = STATUS_STYLE[file.status];

  useEffect(() => {
    if (!open) return;
    let live = true;
    rest
      .getWorkspaceFileDiff(sessionId, file.path)
      .then((d) => live && setPatch({ text: d.patch, truncated: d.truncated }))
      .catch((err) => live && setError(failureText(err)));
    return () => {
      live = false;
    };
  }, [open, rest, sessionId, file.path, refreshKey]);

  return (
    <div className="border-b border-(--renki-border)/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={file.path}
        className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-(--renki-surface)/60"
      >
        <span className={`w-3 shrink-0 font-mono text-[11px] font-semibold ${style.tone}`} title={style.title}>
          {style.label}
        </span>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-(--renki-fg)">{file.path}</span>
        {file.added === null ? (
          <span className="shrink-0 text-(--renki-fg-muted)">binary</span>
        ) : (
          <span className="shrink-0 font-mono">
            <span className="text-(--renki-success)">+{file.added}</span>{" "}
            <span className="text-(--renki-danger)">−{file.removed}</span>
          </span>
        )}
        <span className={`codicon ${open ? "codicon-chevron-down" : "codicon-chevron-right"} ml-auto shrink-0 text-[12px] text-(--renki-fg-muted)`} />
      </button>
      {open && (
        <div className="bg-(--renki-bg-inset)/70">
          {error ? (
            <PanelNote>{error}</PanelNote>
          ) : !patch ? (
            <div className="p-3">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <UnifiedDiff patch={patch.text} truncated={patch.truncated} />
          )}
        </div>
      )}
    </div>
  );
}

/** A unified diff as coloured lines, git's own header lines left out. */
function UnifiedDiff({ patch, truncated }: { patch: string; truncated: boolean }) {
  const lines = patch.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(l));
  if (lines.every((l) => l === "")) return <PanelNote>No textual difference.</PanelNote>;
  return (
    <div className="overflow-x-auto py-1 font-mono text-[12px]">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`whitespace-pre px-4 leading-5 ${
            l.startsWith("@@")
              ? "text-(--renki-fg-muted)/80"
              : l.startsWith("+")
                ? "bg-(--renki-success)/12 text-(--renki-success)"
                : l.startsWith("-")
                  ? "bg-(--renki-danger)/12 text-(--renki-danger)"
                  : "text-(--renki-fg-muted)"
          }`}
        >
          {l || " "}
        </div>
      ))}
      {truncated && <div className="px-4 py-1 text-(--renki-fg-muted)">… cut off here — the diff is too large to show whole.</div>}
    </div>
  );
}

function FilesTab({ sessionId }: { sessionId: string }) {
  const { rest } = useClient();
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState<WorkspaceDirResponse | null>(null);
  const [file, setFile] = useState<WorkspaceFileResponse | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setListing(null);
    rest
      .listWorkspaceDir(sessionId, dir)
      .then((d) => {
        if (!live) return;
        setListing(d);
        setError(null);
      })
      .catch((err) => live && setError(failureText(err)));
    return () => {
      live = false;
    };
  }, [rest, sessionId, dir]);

  useEffect(() => {
    if (!openFile) return;
    let live = true;
    setFile(null);
    rest
      .readWorkspaceFile(sessionId, openFile)
      .then((f) => live && setFile(f))
      .catch((err) => live && setError(failureText(err)));
    return () => {
      live = false;
    };
  }, [rest, sessionId, openFile]);

  const crumbs = dir ? dir.split("/") : [];
  const join = (name: string) => (dir ? `${dir}/${name}` : name);

  if (openFile) {
    const isMarkdown = /\.(md|markdown|mdx)$/i.test(openFile);
    return (
      <div className="text-xs">
        <div className="flex items-center gap-2 border-b border-(--renki-border)/60 px-4 py-2.5">
          <button
            type="button"
            onClick={() => setOpenFile(null)}
            title="Back to the folder"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-(--renki-fg-muted) hover:bg-(--renki-hover) hover:text-(--renki-fg)"
          >
            <span className="codicon codicon-arrow-left text-[12px]" />
          </button>
          <span className="min-w-0 truncate font-mono text-[12.5px] text-(--renki-fg)" title={openFile}>
            {openFile}
          </span>
          {file && <span className="ml-auto shrink-0 text-(--renki-fg-muted)">{formatBytes(file.size)}</span>}
        </div>
        {error ? (
          <PanelNote>{error}</PanelNote>
        ) : !file ? (
          <PanelSkeleton />
        ) : file.binary ? (
          <PanelNote>Binary file — nothing to show as text.</PanelNote>
        ) : isMarkdown ? (
          <div className="px-5 py-4 text-[14px]">
            <Markdown content={file.content ?? ""} />
          </div>
        ) : (
          <pre className="overflow-x-auto px-4 py-3 font-mono text-[12px] leading-5 text-(--renki-fg)">{file.content}</pre>
        )}
        {file?.truncated && <PanelNote>Only the first 512 KB is shown.</PanelNote>}
      </div>
    );
  }

  return (
    <div className="text-xs">
      <div className="flex flex-wrap items-center gap-1 px-4 py-3 font-mono text-[12px] text-(--renki-fg-muted)">
        <button type="button" onClick={() => setDir("")} className="rounded px-1 hover:bg-(--renki-hover) hover:text-(--renki-fg)">
          root
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <span>/</span>
            <button
              type="button"
              onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}
              className="rounded px-1 hover:bg-(--renki-hover) hover:text-(--renki-fg)"
            >
              {c}
            </button>
          </span>
        ))}
      </div>
      {error ? (
        <PanelNote>{error}</PanelNote>
      ) : !listing ? (
        <PanelSkeleton />
      ) : listing.entries.length === 0 ? (
        <PanelNote>This folder is empty.</PanelNote>
      ) : (
        <div className="border-t border-(--renki-border)/60">
          {listing.entries.map((e) => (
            <button
              key={e.name}
              type="button"
              onClick={() => (e.type === "dir" ? setDir(join(e.name)) : setOpenFile(join(e.name)))}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors hover:bg-(--renki-surface)/60"
            >
              <span
                className={`codicon ${e.type === "dir" ? "codicon-folder text-(--renki-accent)" : "codicon-file text-(--renki-fg-muted)"} shrink-0 text-[13px]`}
              />
              <span className="min-w-0 truncate text-[13px] text-(--renki-fg)">{e.name}</span>
              {e.size != null && <span className="ml-auto shrink-0 text-(--renki-fg-muted)">{formatBytes(e.size)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function PanelNote({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-3 text-xs text-(--renki-fg-muted)">{children}</div>;
}

function PanelSkeleton() {
  return (
    <div className="space-y-2 px-4 py-3">
      <Skeleton className="h-3.5 w-3/4" />
      <Skeleton className="h-3.5 w-1/2" />
      <Skeleton className="h-3.5 w-2/3" />
    </div>
  );
}
