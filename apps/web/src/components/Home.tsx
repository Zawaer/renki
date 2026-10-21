import type { Attachment, Session, StatsBucket, StatsResponse } from "@renki/protocol";
import {
  activityGrid,
  formatCost,
  formatDayLabel,
  formatDuration,
  formatModelLabel,
  formatAgo,
  formatResumeAt,
  formatSuccessRate,
  formatTokenCount,
  sessionsNeedingAttention,
  type AttentionReason,
  intensity,
  streaks,
  resolveRepoChoice,
  type RepoChoice,
  sumRecent,
  tokensInPerspective,
  totalTokens,
} from "@renki/client-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useClient, useStoreValue } from "../lib/client.js";
import { loadDeviceDefaults } from "../lib/composerPrefs.js";
import { RepoPicker, useRepoChoices } from "./RepoPicker.js";
import { AttachmentChip, Composer } from "./SessionView.js";
import { Skeleton } from "./ui.js";

type Range = "all" | "30d" | "7d" | "1d";
type Tab = "overview" | "models";

const HEATMAP_WEEKS = 26;

/** Resolves once `selector` matches (or after `timeoutMs`, so a slow render never hangs the transition). */
function untilPresent(selector: string, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    if (document.querySelector(selector)) return resolve();
    const done = () => {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(() => document.querySelector(selector) && done());
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(done, timeoutMs);
  });
}

/** How long the dashboard takes to step aside — the view transition waits for it. */
const LEAVE_MS = 360;

/**
 * Start a chat by just typing, like the Claude app: the session is created
 * when the first message is sent, as a repo-less chat unless a repo is picked
 * from the chip. Picking one the host hasn't cloned yet clones it first.
 *
 * Sending plays out as one motion: the dashboard lifts away and the message
 * rises out of the composer as a bubble; once the session exists, a view
 * transition carries that bubble to the top of the new chat while the
 * composer stays put and the chat's header drops in (see index.css).
 */
function NewChat({ initialRepoId, onLeaving }: { initialRepoId: string | null; onLeaving: (leaving: boolean) => void }) {
  const { rest, realtime } = useClient();
  const navigate = useNavigate();
  const connection = useStoreValue(realtime.status);
  const repos = useRepoChoices();
  const [repo, setRepo] = useState<RepoChoice | null>(null);
  // The sidebar's per-repo "+" lands here with that repo picked.
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || !initialRepoId || !repos.choices) return;
    const match = repos.choices.find((c) => c.local?.id === initialRepoId);
    if (match && repos.github) {
      preselected.current = true;
      setRepo(match);
    }
  }, [initialRepoId, repos]);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The message on its way, shown as the bubble it's about to become. */
  const [outgoing, setOutgoing] = useState<{ text: string; attachments: Attachment[] } | null>(null);

  async function start(text: string, opts: Parameters<typeof realtime.submitPrompt>[2]) {
    setError(null);
    setOutgoing({ text, attachments: opts?.attachments ?? [] });
    onLeaving(true);
    const stepAside = new Promise((r) => setTimeout(r, LEAVE_MS));
    try {
      let target: { repoId: string; baseBranch: string } | null = null;
      if (repo) {
        if (!repo.local) setProgress(`Cloning ${repo.fullName}…`);
        const r = await resolveRepoChoice(rest, repo);
        target = { repoId: r.id, baseBranch: r.defaultBranch };
      }
      if (target) setProgress("Getting the latest from GitHub…");
      // This browser's defaults, which the pickers above have just been writing to.
      const composer = loadDeviceDefaults();
      const session = await rest.createSession(target ? { ...target, composer } : { composer });
      realtime.takeControl(session.id);
      realtime.submitPrompt(session.id, text, opts);
      await stepAside;
      const go = () => navigate(`/session/${encodeURIComponent(session.id)}`, { state: { fromHome: true } });
      if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        // The router commits inside a React transition, so the chat isn't on screen
        // when navigate returns; the browser's "after" picture has to wait for it.
        document.startViewTransition(() => {
          go();
          return untilPresent('[data-first-prompt]');
        });
      } else go();
    } catch (e) {
      setProgress(null);
      setOutgoing(null);
      onLeaving(false);
      setError(e instanceof Error ? e.message : "Couldn't start the session.");
      throw e;
    }
  }

  return (
    <div className="shrink-0">
      {outgoing && (
        <div className="mx-auto w-full max-w-3xl px-6 pb-4">
          <div className="flex justify-end">
            {/* The same box TimelineRow draws, named the same, so the view transition can morph one into the other. */}
            <div
              className="renki-bubble-rise max-w-[85%] rounded-2xl bg-(--renki-surface) px-4 py-3"
              style={{ viewTransitionName: "renki-first-prompt" }}
            >
              {outgoing.text && (
                <div className="line-clamp-[14] whitespace-pre-wrap text-[14px] leading-relaxed text-(--renki-fg)">{outgoing.text}</div>
              )}
              {outgoing.attachments.length > 0 && (
                <div className={`flex flex-wrap gap-1.5 ${outgoing.text ? "mt-2" : ""}`}>
                  {outgoing.attachments.map((a, i) => (
                    <AttachmentChip key={i} attachment={a} siblings={outgoing.attachments} />
                  ))}
                </div>
              )}
            </div>
          </div>
          {progress && (
            <div className="renki-fade mt-2 flex items-center justify-end gap-1.5 text-xs text-(--renki-fg-muted)">
              <span className="codicon codicon-loading codicon-modifier-spin text-[11px]" /> {progress}
            </div>
          )}
        </div>
      )}
      {error && <div className="renki-enter mx-auto max-w-3xl px-6 pb-2 text-center text-xs text-(--renki-danger)">{error}</div>}
      <Composer
        sessionId={null}
        composer={null}
        disabled={connection !== "open"}
        loading={false}
        reason="Connecting to the daemon…"
        placeholder="Describe a task or ask a question"
        onSend={start}
        busy={false}
        onStop={() => {}}
        controls={<RepoPicker {...repos} value={repo} onChange={setRepo} disabled={outgoing !== null} />}
      />
    </div>
  );
}

/**
 * The home screen — what you see with no session open. A greeting and one
 * compact card: headline numbers for a time range, a half-year activity
 * heatmap, and a line that puts the token total in perspective. Everything is
 * derived from the same turn_result buckets the Stats page shows; this is the
 * glanceable version, Stats is the deep one.
 */
export function Home() {
  const { rest, realtime } = useClient();
  const navigate = useNavigate();
  const { search } = useLocation();
  /** A chat is being started: the dashboard steps aside for it. */
  const [leaving, setLeaving] = useState(false);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [range, setRange] = useState<Range>("all");
  const [tab, setTab] = useState<Tab>("overview");

  const refresh = useCallback(() => {
    rest
      .getStats()
      .then((s) => {
        setStats(s);
        setFailed(false);
      })
      .catch(() => setFailed(true));
    rest.listSessions().then(setSessions).catch(() => {});
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Live, so a session that starts waiting on you shows up here as it happens.
  useEffect(() => {
    const offChanged = realtime.onSessionChanged((session) =>
      setSessions((prev) => (prev ? [session, ...prev.filter((s) => s.id !== session.id)] : prev)),
    );
    const offRemoved = realtime.onSessionRemoved((id) => setSessions((prev) => prev?.filter((s) => s.id !== id) ?? prev));
    return () => {
      offChanged();
      offRemoved();
    };
  }, [realtime]);

  const attention = useMemo(() => (sessions ? sessionsNeedingAttention(sessions) : []), [sessions]);

  const grid = useMemo(() => (stats ? activityGrid(HEATMAP_WEEKS, stats.daily) : []), [stats]);
  const maxDay = useMemo(() => grid.reduce((m, col) => Math.max(m, ...col.map((c) => c.turnCount)), 0), [grid]);
  const streak = useMemo(() => (stats ? streaks(stats.daily) : { current: 0, longest: 0 }), [stats]);

  const rangeDays = range === "1d" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : null;
  const bucket: StatsBucket | null = stats ? (rangeDays ? sumRecent(rangeDays, stats.daily) : stats.lifetime) : null;
  const activeDays = stats
    ? stats.daily.filter((d) => d.turnCount > 0 && (!rangeDays || withinDays(d.key, rangeDays))).length
    : 0;
  const sessionCount = sessions
    ? sessions.filter((s) => !rangeDays || Date.now() - s.createdAt <= rangeDays * 86_400_000).length
    : null;

  return (
    <div className="flex h-full flex-col">
      <div className={`min-h-0 flex-1 overflow-y-auto ${leaving ? "renki-home-out" : ""}`} aria-hidden={leaving || undefined}>
      <div className="mx-auto w-full max-w-2xl px-6 pt-16 pb-12">
        <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight text-(--renki-fg)">
          <span className="codicon codicon-sparkle-filled text-[22px] text-(--renki-accent)" />
          {greeting()}
        </h1>

        {attention.length > 0 && (
          <section className="renki-enter mt-8" aria-label="Needs your attention">
            <div className="mb-2 text-[13px] font-medium text-(--renki-fg-muted)">Needs your attention</div>
            <div className="overflow-hidden rounded-2xl bg-(--renki-surface) shadow-(--renki-shadow-sm)">
              {attention.map(({ session, reason }) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => navigate(`/session/${encodeURIComponent(session.id)}`)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] transition-colors not-last:border-b not-last:border-(--renki-border)/60 hover:bg-(--renki-hover)"
                >
                  <AttentionBadge reason={reason} resumeAt={session.resume?.at ?? null} />
                  <span className="min-w-0 flex-1 truncate text-(--renki-fg)">{session.title || session.repoName}</span>
                  <span className="shrink-0 truncate text-xs text-(--renki-fg-muted)">{session.repoName}</span>
                  <span className="shrink-0 text-xs text-(--renki-fg-muted)">{formatAgo(session.lastActivityAt)}</span>
                  <span className="codicon codicon-chevron-right shrink-0 text-[12px] text-(--renki-fg-muted)" />
                </button>
              ))}
            </div>
          </section>
        )}

        {failed && (
          <div className="mt-8 rounded-xl bg-(--renki-surface) p-5 text-sm text-(--renki-fg-muted) shadow-(--renki-shadow-xs)">
            Couldn't load your activity — check the daemon connection.
          </div>
        )}

        {!stats && !failed && (
          <div className="mt-8 rounded-2xl bg-(--renki-surface) p-4 shadow-(--renki-shadow-sm)" aria-busy="true" aria-label="Loading activity">
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <Skeleton className="h-7 w-20" />
                <Skeleton className="h-7 w-16" />
              </div>
              <Skeleton className="h-7 w-24" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="rounded-xl bg-(--renki-bg) px-3 py-2.5">
                  <Skeleton className="h-2.5 w-16" />
                  <Skeleton className="mt-2 h-4 w-12" />
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-1 overflow-hidden">
              {Array.from({ length: HEATMAP_WEEKS }, (_, c) => (
                <div key={c} className="flex flex-col gap-1">
                  {Array.from({ length: 7 }, (_, r) => (
                    <Skeleton key={r} className="h-4 w-4 rounded-[4px]" />
                  ))}
                </div>
              ))}
            </div>
            <Skeleton className="mt-4 h-3 w-72" />
          </div>
        )}

        {stats && stats.lifetime.turnCount === 0 && (
          <div className="mt-8 rounded-xl bg-(--renki-surface) p-6 shadow-(--renki-shadow-xs)">
            <div className="text-sm font-medium text-(--renki-fg)">Nothing to show yet</div>
            <div className="mt-1 text-xs text-(--renki-fg-muted)">
              Send a message above to start a session — your activity, streaks and spend will show up here.
            </div>
          </div>
        )}

        {stats && bucket && stats.lifetime.turnCount > 0 && (
          <div className="renki-enter mt-8 rounded-2xl bg-(--renki-surface) p-4 shadow-(--renki-shadow-sm)">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1 text-sm">
                <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
                  Overview
                </TabButton>
                <TabButton active={tab === "models"} onClick={() => setTab("models")}>
                  Models
                </TabButton>
              </div>
              {tab === "overview" && (
                <div className="flex items-center gap-0.5 text-xs">
                  {(["all", "30d", "7d", "1d"] as Range[]).map((r) => (
                    <button
                      key={r}
                      onClick={() => setRange(r)}
                      className={`h-7 rounded-md px-2 transition-colors ${
                        range === r
                          ? "bg-(--renki-accent)/12 font-medium text-(--renki-fg) ring-1 ring-(--renki-accent)/40 ring-inset"
                          : "text-(--renki-fg-muted) hover:bg-(--renki-hover) hover:text-(--renki-fg)"
                      }`}
                    >
                      {r === "all" ? "All" : r}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {tab === "overview" ? (
              <>
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Tile label="Sessions" value={sessionCount == null ? "…" : String(sessionCount)} />
                  <Tile label="Replies" value={String(bucket.turnCount)} />
                  <Tile
                    label="Total tokens"
                    value={formatTokenCount(totalTokens(bucket))}
                    detail={`${formatTokenCount(bucket.inputTokens + bucket.outputTokens)} new · ${formatTokenCount(bucket.cachedInputTokens ?? 0)} cached`}
                  />
                  <Tile label="Spend" value={formatCost(bucket.costUsd)} />
                  <Tile label="Active days" value={String(activeDays)} />
                  <Tile label="Current streak" value={`${streak.current}d`} />
                  <Tile label="Longest streak" value={`${streak.longest}d`} />
                  <Tile label="Success rate" value={formatSuccessRate(bucket)} />
                </div>

                <div className="mt-4 overflow-x-auto">
                  <div className="flex gap-1" style={{ minWidth: HEATMAP_WEEKS * 20 }} aria-label="Activity over the last six months">
                    {grid.map((col, ci) => (
                      <div key={ci} className="flex flex-col gap-1">
                        {col.map((cell) => (
                          <span
                            key={cell.key}
                            title={
                              cell.future
                                ? ""
                                : `${formatDayLabel(cell.key)}: ${cell.turnCount === 0 ? "no replies" : `${cell.turnCount} repl${cell.turnCount === 1 ? "y" : "ies"} · ${formatCost(cell.costUsd)}`}`
                            }
                            className={`h-4 w-4 rounded-[4px] ${cell.future ? "opacity-0" : heatClass(intensity(cell.turnCount, maxDay))}`}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-(--renki-fg-muted)">
                  <span>{tokensInPerspective(totalTokens(stats.lifetime))}</span>
                  <span className="whitespace-nowrap">{formatDuration(stats.lifetime.durationMs)} spent waiting on Claude</span>
                </div>
              </>
            ) : (
              <ModelsTab models={stats.byModel} />
            )}
          </div>
        )}
      </div>
      </div>

      {/* Where it sits in a chat, so starting one only has to move the message. Keyed on the
          query so "New" in the sidebar starts it over (and focuses it) even from here. */}
      <NewChat key={search} initialRepoId={new URLSearchParams(search).get("repo")} onLeaving={setLeaving} />
    </div>
  );
}

function ModelsTab({ models }: { models: StatsBucket[] }) {
  const maxCost = models.reduce((m, b) => Math.max(m, b.costUsd), 0);
  if (models.length === 0) return <div className="mt-4 text-sm text-(--renki-fg-muted)">No model breakdown yet.</div>;
  return (
    <div className="mt-4 space-y-2">
      {models.map((m) => (
        <div key={m.key} className="rounded-xl bg-(--renki-bg) px-3 py-2.5">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium text-(--renki-fg)">{formatModelLabel(m.key)}</span>
            <span className="shrink-0 text-xs text-(--renki-fg-muted)">
              {m.turnCount} repl{m.turnCount === 1 ? "y" : "ies"} · {formatTokenCount(totalTokens(m))} tokens ·{" "}
              <span className="text-(--renki-fg)">{formatCost(m.costUsd)}</span>
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-(--renki-bg-inset)">
            <div className="h-full rounded-full bg-(--renki-accent)" style={{ width: `${maxCost > 0 ? Math.max(2, (m.costUsd / maxCost) * 100) : 0}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl bg-(--renki-bg) px-3 py-2.5">
      <div className="text-[11px] font-medium text-(--renki-fg-muted)">{label}</div>
      <div className="mt-0.5 text-base font-semibold tracking-tight text-(--renki-fg)">{value}</div>
      {detail && <div className="mt-0.5 text-[11px] text-(--renki-fg-muted)">{detail}</div>}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-7 rounded-md px-2.5 transition-colors ${
        active ? "bg-(--renki-hover) font-medium text-(--renki-fg)" : "text-(--renki-fg-muted) hover:text-(--renki-fg)"
      }`}
    >
      {children}
    </button>
  );
}

function heatClass(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 0:
      return "bg-(--renki-bg-inset)";
    case 1:
      return "bg-(--renki-accent)/30";
    case 2:
      return "bg-(--renki-accent)/50";
    case 3:
      return "bg-(--renki-accent)/75";
    default:
      return "bg-(--renki-accent)";
  }
}

function withinDays(dayKey: string, days: number): boolean {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days + 1);
  return dayKey >= start.toISOString().slice(0, 10);
}

function greeting(): string {
  const h = new Date().getHours();
  const part = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return `${part}. What's up next?`;
}

/** Why a session is on the attention list, in a word or two and a colour. */
function AttentionBadge({ reason, resumeAt }: { reason: AttentionReason; resumeAt: number | null }) {
  const { icon, tone, label } =
    reason === "permission"
      ? { icon: "codicon-shield", tone: "text-(--renki-danger)", label: "Needs approval" }
      : reason === "error"
        ? { icon: "codicon-error", tone: "text-(--renki-danger)", label: "Failed" }
        : { icon: "codicon-debug-pause", tone: "text-(--renki-warning)", label: resumeAt ? formatResumeAt(resumeAt) : "Paused" };
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${tone}`}>
      <span className={`codicon ${icon} text-[13px]`} />
      {label}
    </span>
  );
}
