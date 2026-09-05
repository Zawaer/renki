import type { Session, StatsBucket, StatsResponse } from "@crc/protocol";
import {
  activityGrid,
  formatCost,
  formatDayLabel,
  formatDuration,
  formatModelLabel,
  formatSuccessRate,
  formatTokenCount,
  intensity,
  streaks,
  sumRecent,
  tokensInPerspective,
} from "@crc/client-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useClient } from "../lib/client.js";

type Range = "all" | "30d" | "7d";
type Tab = "overview" | "models";

const HEATMAP_WEEKS = 26;

/**
 * The home screen — what you see with no session open. A greeting and one
 * compact card: headline numbers for a time range, a half-year activity
 * heatmap, and a line that puts the token total in perspective. Everything is
 * derived from the same turn_result buckets the Stats page shows; this is the
 * glanceable version, Stats is the deep one.
 */
export function Home() {
  const { rest } = useClient();
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

  const grid = useMemo(() => (stats ? activityGrid(HEATMAP_WEEKS, stats.daily) : []), [stats]);
  const maxDay = useMemo(() => grid.reduce((m, col) => Math.max(m, ...col.map((c) => c.turnCount)), 0), [grid]);
  const streak = useMemo(() => (stats ? streaks(stats.daily) : { current: 0, longest: 0 }), [stats]);

  const rangeDays = range === "7d" ? 7 : range === "30d" ? 30 : null;
  const bucket: StatsBucket | null = stats ? (rangeDays ? sumRecent(rangeDays, stats.daily) : stats.lifetime) : null;
  const activeDays = stats
    ? stats.daily.filter((d) => d.turnCount > 0 && (!rangeDays || withinDays(d.key, rangeDays))).length
    : 0;
  const sessionCount = sessions
    ? sessions.filter((s) => !rangeDays || Date.now() - s.createdAt <= rangeDays * 86_400_000).length
    : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 pt-16 pb-12">
        <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight text-(--crc-fg)">
          <span className="codicon codicon-sparkle-filled text-[22px] text-(--crc-accent)" />
          {greeting()}
        </h1>

        {failed && (
          <div className="mt-8 rounded-xl bg-(--crc-surface) p-5 text-sm text-(--crc-fg-muted) shadow-(--crc-shadow-xs)">
            Couldn't load your activity — check the daemon connection.
          </div>
        )}

        {stats && stats.lifetime.turnCount === 0 && (
          <div className="mt-8 rounded-xl bg-(--crc-surface) p-6 shadow-(--crc-shadow-xs)">
            <div className="text-sm font-medium text-(--crc-fg)">Nothing to show yet</div>
            <div className="mt-1 text-xs text-(--crc-fg-muted)">
              Start a session from the sidebar and send a prompt — your activity, streaks and spend will show up here.
            </div>
          </div>
        )}

        {stats && bucket && stats.lifetime.turnCount > 0 && (
          <div className="crc-enter mt-8 rounded-2xl bg-(--crc-surface) p-4 shadow-(--crc-shadow-sm)">
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
                  {(["all", "30d", "7d"] as Range[]).map((r) => (
                    <button
                      key={r}
                      onClick={() => setRange(r)}
                      className={`h-7 rounded-md px-2 transition-colors ${
                        range === r
                          ? "bg-(--crc-accent)/12 font-medium text-(--crc-fg) ring-1 ring-(--crc-accent)/40 ring-inset"
                          : "text-(--crc-fg-muted) hover:bg-(--crc-hover) hover:text-(--crc-fg)"
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
                  <Tile label="Total tokens" value={formatTokenCount(bucket.inputTokens + bucket.outputTokens)} />
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

                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-(--crc-fg-muted)">
                  <span>{tokensInPerspective(stats.lifetime.inputTokens + stats.lifetime.outputTokens)}</span>
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
  );
}

function ModelsTab({ models }: { models: StatsBucket[] }) {
  const maxCost = models.reduce((m, b) => Math.max(m, b.costUsd), 0);
  if (models.length === 0) return <div className="mt-4 text-sm text-(--crc-fg-muted)">No model breakdown yet.</div>;
  return (
    <div className="mt-4 space-y-2">
      {models.map((m) => (
        <div key={m.key} className="rounded-xl bg-(--crc-bg) px-3 py-2.5">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium text-(--crc-fg)">{formatModelLabel(m.key)}</span>
            <span className="shrink-0 text-xs text-(--crc-fg-muted)">
              {m.turnCount} repl{m.turnCount === 1 ? "y" : "ies"} · {formatTokenCount(m.inputTokens + m.outputTokens)} tokens ·{" "}
              <span className="text-(--crc-fg)">{formatCost(m.costUsd)}</span>
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-(--crc-bg-inset)">
            <div className="h-full rounded-full bg-(--crc-accent)" style={{ width: `${maxCost > 0 ? Math.max(2, (m.costUsd / maxCost) * 100) : 0}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-(--crc-bg) px-3 py-2.5">
      <div className="text-[11px] font-medium text-(--crc-fg-muted)">{label}</div>
      <div className="mt-0.5 text-base font-semibold tracking-tight text-(--crc-fg)">{value}</div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-7 rounded-md px-2.5 transition-colors ${
        active ? "bg-(--crc-hover) font-medium text-(--crc-fg)" : "text-(--crc-fg-muted) hover:text-(--crc-fg)"
      }`}
    >
      {children}
    </button>
  );
}

function heatClass(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 0:
      return "bg-(--crc-bg-inset)";
    case 1:
      return "bg-(--crc-accent)/30";
    case 2:
      return "bg-(--crc-accent)/50";
    case 3:
      return "bg-(--crc-accent)/75";
    default:
      return "bg-(--crc-accent)";
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
