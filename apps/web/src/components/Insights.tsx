import type {
  InsightsResponse,
  StatsRecord,
  StatsResponse,
} from "@renki/protocol";
import {
  WEEKDAYS,
  busiestHour,
  formatClientTypeLabel,
  formatCost,
  formatCount,
  formatDayLabel,
  formatDuration,
  formatHourRange,
  formatModelLabel,
  formatMonthLabel,
  formatShare,
  formatTokenCount,
  modelShare,
  planValue,
  recentLines,
  tokensPerMinute,
} from "@renki/client-core";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bars, ChartCard, Legend, Section, StatTile } from "./StatsParts.js";

const SERIES = [
  "var(--renki-series-1)",
  "var(--renki-series-2)",
  "var(--renki-series-3)",
  "var(--renki-series-4)",
  "var(--renki-series-5)",
];
const LINE_DAYS = 30;
const PLAN_KEY = "renki.stats.planUsdPerMonth";

/**
 * The Stats page past cost and tokens: when you work, what Claude does, how
 * approvals go, limits, records and a few things just for fun. Everything
 * comes from one /stats/insights response; `stats` supplies the monthly
 * spend the plan-value tile compares against.
 */
export function Insights({
  data,
  stats,
}: {
  data: InsightsResponse;
  stats: StatsResponse;
}) {
  return (
    <>
      <HabitsSection data={data} />
      <CodeSection data={data} />
      <ClaudeSection data={data} />
      <ApprovalsSection data={data} />
      <LimitsSection data={data} stats={stats} />
      <ModelShareSection data={data} />
      <RecordsSection data={data} />
      <AchievementsSection data={data} />
    </>
  );
}

// ── Your habits ──────────────────────────────────────────────────────────────

function HabitsSection({ data }: { data: InsightsResponse }) {
  const peak = busiestHour(data.heatmap);
  return (
    <Section
      title="Your habits"
      table={<HeatmapTable heatmap={data.heatmap} />}
    >
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Current streak" value={days(data.streak.current)} />
        <StatTile label="Longest streak" value={days(data.streak.longest)} />
        <StatTile
          label="Days active"
          value={formatCount(data.streak.activeDays)}
        />
        <StatTile
          label="Prompts sent"
          value={formatCount(data.prompts.count)}
        />
        <StatTile
          label="Typical prompt"
          value={`${formatCount(data.prompts.medianChars)} chars`}
        />
        <StatTile
          label="Steered mid-turn"
          value={formatCount(data.prompts.steered)}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <ChartCard title="When you work">
          <Heatmap heatmap={data.heatmap} />
          <p className="mt-2 text-[11px] text-(--renki-fg-muted)">
            {peak
              ? `Busiest: ${WEEKDAYS[peak.weekday]} ${formatHourRange(peak.hour)}, ${peak.turns} turns.`
              : "No turns yet."}{" "}
            Turns by when they started, in {data.tz}.
          </p>
        </ChartCard>
        <ChartCard title="Streaks by repo">
          <RankList
            rows={data.repoStreaks.map((r) => ({
              key: r.repoName,
              label: r.repoName,
              value: r.longest,
              display: `${r.current > 0 ? `${r.current} now · ` : ""}${r.longest} best`,
              tooltip: `${r.repoName}\nCurrent ${days(r.current)} · longest ${days(r.longest)} · ${r.activeDays} days active`,
            }))}
          />
        </ChartCard>
      </div>
    </Section>
  );
}

/**
 * Turns started per weekday and hour. One hue, light to dark (sequential),
 * stepped by opacity over the surface so it reads in both themes. A hovered
 * cell names itself in the caption row above the grid.
 */
function Heatmap({ heatmap }: { heatmap: number[][] }) {
  const [hover, setHover] = useState<{ weekday: number; hour: number } | null>(
    null,
  );
  const max = Math.max(1, ...heatmap.flat());
  const readout = hover
    ? `${WEEKDAYS[hover.weekday]} ${formatHourRange(hover.hour)} · ${heatmap[hover.weekday]![hover.hour]} turn${heatmap[hover.weekday]![hover.hour] === 1 ? "" : "s"}`
    : " ";
  return (
    <div onMouseLeave={() => setHover(null)}>
      <div
        className="mb-1 h-4 text-[11px] tabular-nums text-(--renki-fg)"
        aria-live="polite"
      >
        {readout}
      </div>
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[26rem] gap-[2px]"
          style={{ gridTemplateColumns: "2rem repeat(24, minmax(0, 1fr))" }}
        >
          {heatmap.map((row, weekday) => (
            <HeatRow
              key={weekday}
              weekday={weekday}
              row={row}
              max={max}
              onHover={(hour) => setHover({ weekday, hour })}
            />
          ))}
          <span />
          {Array.from({ length: 24 }, (_, h) => (
            <span
              key={h}
              className="text-center text-[9px] text-(--renki-fg-muted)"
            >
              {h % 6 === 0 ? h : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function HeatRow({
  weekday,
  row,
  max,
  onHover,
}: {
  weekday: number;
  row: number[];
  max: number;
  onHover: (hour: number) => void;
}) {
  return (
    <>
      <span className="self-center text-[10px] text-(--renki-fg-muted)">
        {WEEKDAYS[weekday]}
      </span>
      {row.map((turns, hour) => (
        <span
          key={hour}
          onMouseEnter={() => onHover(hour)}
          aria-label={`${WEEKDAYS[weekday]} ${formatHourRange(hour)}: ${turns} turns`}
          className="aspect-square rounded-[3px] transition-transform hover:scale-110"
          style={{
            background:
              turns === 0
                ? "var(--renki-bg-inset)"
                : `color-mix(in oklab, var(--renki-accent) ${Math.round(18 + (turns / max) * 82)}%, var(--renki-surface))`,
          }}
        />
      ))}
    </>
  );
}

function HeatmapTable({ heatmap }: { heatmap: number[][] }) {
  return (
    <Table
      head={["", ...Array.from({ length: 24 }, (_, h) => String(h))]}
      rows={heatmap.map((row, i) => [WEEKDAYS[i]!, ...row.map(String)])}
    />
  );
}

// ── Code ─────────────────────────────────────────────────────────────────────

function CodeSection({ data }: { data: InsightsResponse }) {
  const lines = recentLines(LINE_DAYS, data.linesDaily);
  const added = data.linesDaily.reduce((s, d) => s + d.added, 0);
  const removed = data.linesDaily.reduce((s, d) => s + d.removed, 0);
  if (added + removed === 0 && data.git.commits === 0) return null;
  return (
    <Section
      title="Code"
      table={
        <Table
          head={["Repo", "File", "Edits", "Added", "Removed"]}
          rows={data.topFiles.map((f) => [
            f.repoName,
            f.path,
            String(f.edits),
            `+${f.added}`,
            `−${f.removed}`,
          ])}
        />
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Lines added" value={formatCount(added)} />
        <StatTile label="Lines removed" value={formatCount(removed)} />
        <StatTile label="Commits" value={formatCount(data.git.commits)} />
        <StatTile label="Merges" value={formatCount(data.git.merges)} />
        <StatTile label="Pushes" value={formatCount(data.git.pushes)} />
        <StatTile
          label="Files touched"
          value={formatCount(data.filesTouched)}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title={`Lines changed, last ${LINE_DAYS} days`}>
          <Legend
            items={[
              { label: "Added", color: SERIES[0]! },
              { label: "Removed", color: SERIES[1]! },
            ]}
          />
          <Bars
            items={lines.map((d) => ({
              key: d.day,
              label: formatDayLabel(d.day),
              a: d.added,
              b: d.removed,
              tooltip: `${formatDayLabel(d.day)}\n+${formatCount(d.added)} · −${formatCount(d.removed)}`,
            }))}
            colorA={SERIES[0]!}
            colorB={SERIES[1]!}
          />
        </ChartCard>
        <ChartCard title="Most edited files">
          <RankList
            rows={data.topFiles.map((f) => ({
              key: `${f.repoName}/${f.path}`,
              label: fileLabel(f, data.topFiles),
              value: f.edits,
              display: `${f.edits}`,
              tooltip: `${f.repoName} · ${f.path}\n${f.edits} edits · +${f.added} −${f.removed}`,
            }))}
          />
        </ChartCard>
      </div>
      <p className="mt-2 text-[10px] text-(--renki-fg-muted)">
        Counted from Claude's own edits and git commands; changes you make by
        hand aren't here.
      </p>
    </Section>
  );
}

// ── Claude's work ────────────────────────────────────────────────────────────

function ClaudeSection({ data }: { data: InsightsResponse }) {
  const toolTotal = data.tools.reduce((s, t) => s + t.count, 0);
  const o = data.outcomes;
  const outcomeTotal = o.ok + o.stopped + o.limited + o.restarted + o.errored;
  const handsOffShare = formatShare(
    data.handsOff.handsOffMs,
    data.handsOff.turnMs,
  );
  return (
    <Section
      title="Claude's work"
      table={
        <Table
          head={["Tool", "Calls", "Failed"]}
          rows={data.tools.map((t) => [
            t.name,
            formatCount(t.count),
            formatCount(t.failed),
          ])}
        />
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Tool calls" value={formatCount(toolTotal)} />
        <StatTile
          label="Agents launched"
          value={formatCount(data.agents.count)}
        />
        <StatTile
          label="In the background"
          value={formatCount(data.agents.background)}
        />
        <StatTile
          label="Typical agent run"
          value={
            data.agents.medianDurationMs != null
              ? formatDuration(data.agents.medianDurationMs)
              : "—"
          }
        />
        <StatTile
          label="Hands-off time"
          value={formatDuration(data.handsOff.handsOffMs)}
        />
        <StatTile label="Of turn time" value={handsOffShare} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Tools">
          <RankList
            rows={data.tools.slice(0, 10).map((t) => ({
              key: t.name,
              label: t.name,
              value: t.count,
              display: formatCount(t.count),
              tooltip: `${t.name}\n${formatCount(t.count)} calls · ${formatCount(t.failed)} failed (${formatShare(t.failed, t.count)})`,
            }))}
          />
        </ChartCard>
        <ChartCard title="Shell commands">
          <RankList
            rows={data.shellCommands.map((c) => ({
              key: c.key,
              label: c.key,
              value: c.count,
              display: formatCount(c.count),
              mono: true,
            }))}
          />
        </ChartCard>
        <ChartCard title="Speed, output tokens a minute">
          <RankList
            rows={data.speed.map((s) => {
              const tpm = tokensPerMinute(s) ?? 0;
              return {
                key: s.model,
                label: formatModelLabel(s.model),
                value: tpm,
                display: formatCount(tpm),
                tooltip: `${formatModelLabel(s.model)}\n${formatTokenCount(s.outputTokens)} tokens in ${formatDuration(s.durationMs)}`,
              };
            })}
          />
        </ChartCard>
        <ChartCard title="How turns ended">
          <RankList
            rows={[
              { key: "ok", label: "Finished", value: o.ok },
              { key: "stopped", label: "Stopped by you", value: o.stopped },
              { key: "limited", label: "Hit a limit", value: o.limited },
              {
                key: "restarted",
                label: "Cut by a restart",
                value: o.restarted,
              },
              { key: "errored", label: "Errored", value: o.errored },
            ].map((r) => ({
              ...r,
              display: `${formatCount(r.value)} · ${formatShare(r.value, outcomeTotal)}`,
            }))}
          />
        </ChartCard>
        {data.agents.byType.length > 0 && (
          <ChartCard title="Agent types">
            <RankList
              rows={data.agents.byType.map((t) => ({
                key: t.key,
                label: t.key,
                value: t.count,
                display: formatCount(t.count),
              }))}
            />
          </ChartCard>
        )}
        <ChartCard title="Context">
          <div className="grid grid-cols-3 gap-3">
            <Mini
              label="Compactions"
              value={formatCount(data.compactions.count)}
            />
            <Mini
              label="Automatic"
              value={formatCount(data.compactions.auto)}
            />
            <Mini
              label="Typical size"
              value={
                data.compactions.avgPreTokens != null
                  ? formatTokenCount(data.compactions.avgPreTokens)
                  : "—"
              }
            />
          </div>
          <p className="mt-3 text-[10px] text-(--renki-fg-muted)">
            {data.handsOff.since != null
              ? `Hands-off time counts turn time with no device connected, since ${new Date(data.handsOff.since).toLocaleDateString()}. Compactions are counted from the same update.`
              : "Hands-off time and compactions are counted from this update on."}
          </p>
        </ChartCard>
      </div>
    </Section>
  );
}

// ── Approvals ────────────────────────────────────────────────────────────────

function ApprovalsSection({ data }: { data: InsightsResponse }) {
  const a = data.approvals;
  if (a.count === 0) return null;
  const answered = a.allowed + a.denied;
  return (
    <Section
      title="Approvals"
      table={
        <Table
          head={["Tool", "Allowed", "Denied"]}
          rows={a.byTool.map((t) => [
            t.tool,
            String(t.allowed),
            String(t.denied),
          ])}
        />
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Requests" value={formatCount(a.count)} />
        <StatTile label="Allowed" value={formatShare(a.allowed, answered)} />
        <StatTile label="Denied" value={formatCount(a.denied)} />
        <StatTile label="Unanswered" value={formatCount(a.unanswered)} />
        <StatTile
          label="Typical answer time"
          value={
            a.medianResponseMs != null
              ? formatDuration(a.medianResponseMs)
              : "—"
          }
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Answered from">
          <RankList
            rows={a.byDevice.map((d) => ({
              key: d.key,
              label: formatClientTypeLabel(d.key),
              value: d.count,
              display: `${formatCount(d.count)}${d.medianResponseMs != null ? ` · ${formatDuration(d.medianResponseMs)}` : ""}`,
              tooltip: `${formatClientTypeLabel(d.key)}\n${d.count} answered · typically in ${d.medianResponseMs != null ? formatDuration(d.medianResponseMs) : "—"}`,
            }))}
          />
        </ChartCard>
        <ChartCard title="By tool">
          <Legend
            items={[
              { label: "Allowed", color: SERIES[0]! },
              { label: "Denied", color: SERIES[1]! },
            ]}
          />
          <SplitBars
            rows={a.byTool.map((t) => ({
              key: t.tool,
              label: t.tool,
              a: t.allowed,
              b: t.denied,
            }))}
          />
        </ChartCard>
      </div>
    </Section>
  );
}

// ── Limits and accounts ──────────────────────────────────────────────────────

function LimitsSection({
  data,
  stats,
}: {
  data: InsightsResponse;
  stats: StatsResponse;
}) {
  const [plan, setPlan] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(PLAN_KEY));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const savePlan = (v: number | null) => {
    setPlan(v);
    try {
      if (v) localStorage.setItem(PLAN_KEY, String(v));
      else localStorage.removeItem(PLAN_KEY);
    } catch {
      /* private mode: remembered for this visit only */
    }
  };
  const l = data.limits;
  const cacheShare = formatShare(
    data.cache.cachedInputTokens,
    data.cache.cachedInputTokens + data.cache.inputTokens,
  );
  const thisMonth = stats.monthly[stats.monthly.length - 1];
  const lastMonth = stats.monthly[stats.monthly.length - 2];
  return (
    <Section title="Limits and value">
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Limit hits" value={formatCount(l.hits)} />
        <StatTile label="Pauses" value={formatCount(l.pauses)} />
        <StatTile label="Time paused" value={formatDuration(l.pausedMs)} />
        <StatTile label="Account switches" value={formatCount(l.switches)} />
        <StatTile label="Read from cache" value={cacheShare} />
        <StatTile
          label="Cached tokens"
          value={formatTokenCount(data.cache.cachedInputTokens)}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="What your plan is worth">
          <p className="text-[11px] text-(--renki-fg-muted)">
            The same usage, priced as API calls, next to what you pay a month.
          </p>
          <label className="mt-3 flex items-center gap-2 text-[11px] text-(--renki-fg-muted)">
            You pay $
            <input
              type="number"
              min={0}
              step={1}
              inputMode="decimal"
              value={plan ?? ""}
              placeholder="200"
              onChange={(e) =>
                savePlan(
                  Number(e.target.value) > 0 ? Number(e.target.value) : null,
                )
              }
              className="w-20 rounded-sm border border-(--renki-border) bg-(--renki-input-bg) px-2 py-1 text-(--renki-fg) tabular-nums"
            />
            a month, across all accounts
          </label>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {[thisMonth, lastMonth].filter(Boolean).map((m) => (
              <Mini
                key={m!.key}
                label={`${formatMonthLabel(m!.key)}${m!.key === new Date().toISOString().slice(0, 7) ? " so far" : ""}`}
                value={`${formatCost(m!.costUsd)}${planValue(m!.costUsd, plan) ? ` · ${planValue(m!.costUsd, plan)}` : ""}`}
              />
            ))}
          </div>
        </ChartCard>
        {l.switchesTo.length > 0 && (
          <ChartCard title="Switched to">
            <RankList
              rows={l.switchesTo.map((s) => ({
                key: s.key,
                label:
                  s.key === "another" ? "Another account" : `Account ${s.key}`,
                value: s.count,
                display: formatCount(s.count),
              }))}
            />
          </ChartCard>
        )}
      </div>
    </Section>
  );
}

// ── Model share over time ────────────────────────────────────────────────────

function ModelShareSection({ data }: { data: InsightsResponse }) {
  const share = useMemo(
    () => modelShare(data.modelMonthly),
    [data.modelMonthly],
  );
  if (share.months.length === 0 || share.series.length < 2) return null;
  return (
    <Section
      title="Models over time"
      table={
        <Table
          head={["Month", ...share.series.map((s) => s.label)]}
          rows={share.months.map((m) => [
            formatMonthLabel(m.month),
            ...m.shares.map((v) => `${Math.round(v * 100)}%`),
          ])}
        />
      }
    >
      <ChartCard title="Share of output tokens">
        <Legend
          items={share.series.map((s, i) => ({
            label: s.label,
            color: SERIES[i]!,
          }))}
        />
        <StackedArea share={share} />
      </ChartCard>
    </Section>
  );
}

/**
 * 100%-stacked area of model share per month, drawn in SVG: 2px surface
 * seams between bands, a crosshair and a tooltip listing every model's share
 * for the hovered month. A single month is drawn as one stacked column.
 */
function StackedArea({ share }: { share: ReturnType<typeof modelShare> }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 140;
  const n = share.months.length;
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const bands = share.series.map((_, s) => {
    const lower = share.months.map((m) =>
      m.shares.slice(0, s).reduce((a, b) => a + b, 0),
    );
    const upper = share.months.map((m, i) => lower[i]! + m.shares[s]!);
    return { lower, upper };
  });
  const path = (b: { lower: number[]; upper: number[] }) => {
    if (n === 1) {
      const x0 = W / 2 - 40;
      const x1 = W / 2 + 40;
      return `M${x0},${H - b.lower[0]! * H}L${x1},${H - b.lower[0]! * H}L${x1},${H - b.upper[0]! * H}L${x0},${H - b.upper[0]! * H}Z`;
    }
    const top = b.upper
      .map((v, i) => `${i ? "L" : "M"}${x(i)},${H - v * H}`)
      .join("");
    const bottom = b.lower
      .map((v, i) => `L${x(n - 1 - i)},${H - b.lower[n - 1 - i]! * H}`)
      .join("");
    return `${top}${bottom}Z`;
  };
  const month = hover != null ? share.months[hover] : null;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-36 w-full"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(
            n === 1
              ? 0
              : Math.round(((e.clientX - r.left) / r.width) * (n - 1)),
          );
        }}
        onMouseLeave={() => setHover(null)}
      >
        {bands.map((b, i) => (
          <path
            key={i}
            d={path(b)}
            fill={SERIES[i]}
            stroke="var(--renki-surface)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {hover != null && n > 1 && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={0}
            y2={H}
            stroke="var(--renki-fg)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="mt-1 flex justify-between border-t border-(--renki-border) pt-1 text-[9px] text-(--renki-fg-muted)">
        <span>{formatMonthLabel(share.months[0]!.month)}</span>
        {n > 1 && <span>{formatMonthLabel(share.months[n - 1]!.month)}</span>}
      </div>
      {month && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-xl bg-(--renki-surface) px-2.5 py-1.5 text-[10px] text-(--renki-fg) shadow-lg"
          style={{
            left: `${Math.min(85, Math.max(15, (n === 1 ? 0.5 : hover! / (n - 1)) * 100))}%`,
          }}
        >
          <div className="mb-0.5 font-medium">
            {formatMonthLabel(month.month)}
          </div>
          {share.series.map((s, i) => (
            <div key={s.key} className="flex items-center gap-1.5 tabular-nums">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: SERIES[i] }}
              />
              {s.label} {Math.round(month.shares[i]! * 100)}%
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Records and fun ──────────────────────────────────────────────────────────

function RecordsSection({ data }: { data: InsightsResponse }) {
  const r = data.records;
  const words = data.words;
  return (
    <Section title="Records">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <RecordCard
          label="Longest turn"
          record={data.longestTurn}
          value={(v) => formatDuration(v)}
        />
        <RecordCard
          label="Longest session"
          record={data.longestSession}
          value={(v) => `${formatDuration(v)} of turns`}
        />
        <RecordCard
          label="Most expensive turn"
          record={r.mostExpensiveTurn}
          value={(v) => formatCost(v)}
        />
        <RecordCard
          label="Most tool calls in a turn"
          record={r.mostToolsInTurn}
          value={(v) => `${formatCount(v)} calls`}
        />
        <RecordCard
          label="Most files in a session"
          record={r.mostFilesInSession}
          value={(v) => `${formatCount(v)} files`}
        />
        <div className="rounded-xl bg-(--renki-surface) p-4 shadow-(--renki-shadow-xs)">
          <div className="text-[11px] font-medium text-(--renki-fg-muted)">
            Busiest day · most at once
          </div>
          <div className="mt-1 text-xl font-semibold tracking-tight text-(--renki-fg)">
            {r.busiestDay ? `${r.busiestDay.turns} turns` : "—"}
            {r.mostAtOnce ? (
              <span className="text-(--renki-fg-muted)">
                {" "}
                · {r.mostAtOnce.count} at once
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[11px] text-(--renki-fg-muted)">
            {r.busiestDay ? formatDayLabel(r.busiestDay.day) : ""}
          </div>
        </div>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl bg-(--renki-surface) p-4 shadow-(--renki-shadow-xs)">
          <div className="text-[11px] font-medium text-(--renki-fg-muted)">
            Words written
          </div>
          <div className="mt-2 space-y-2">
            <WordBar
              label="Claude"
              value={words.claudes}
              max={Math.max(words.claudes, words.yours, 1)}
              color={SERIES[0]!}
            />
            <WordBar
              label="You"
              value={words.yours}
              max={Math.max(words.claudes, words.yours, 1)}
              color={SERIES[1]!}
            />
          </div>
          <p className="mt-2 text-[11px] text-(--renki-fg-muted)">
            {words.yours > 0
              ? `Claude wrote ${Math.max(1, Math.round(words.claudes / words.yours))} words for every one of yours.`
              : " "}
          </p>
        </div>
        <RememberWhen data={data} />
      </div>
    </Section>
  );
}

function RecordCard({
  label,
  record,
  value,
}: {
  label: string;
  record: StatsRecord | null;
  value: (v: number) => string;
}) {
  const navigate = useNavigate();
  const inner = (
    <>
      <div className="text-[11px] font-medium text-(--renki-fg-muted)">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight text-(--renki-fg)">
        {record ? value(record.value) : "—"}
      </div>
      {record && (
        <div className="mt-1 truncate text-[11px] text-(--renki-fg-muted)">
          {record.session.title ?? record.session.repoName} ·{" "}
          {new Date(record.ts).toLocaleDateString()}
        </div>
      )}
    </>
  );
  const cls =
    "block rounded-xl bg-(--renki-surface) p-4 text-left shadow-(--renki-shadow-xs)";
  if (!record?.session.exists) return <div className={cls}>{inner}</div>;
  return (
    <button
      type="button"
      className={`${cls} w-full min-w-0 transition-colors hover:bg-(--renki-hover)`}
      onClick={() =>
        navigate(`/session/${encodeURIComponent(record.session.sessionId)}`)
      }
    >
      {inner}
    </button>
  );
}

function WordBar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-12 shrink-0 text-[11px] text-(--renki-fg)">{label}</div>
      <div className="h-3 flex-1 overflow-hidden rounded-sm bg-(--renki-bg)">
        <div
          className="h-full rounded-sm"
          style={{
            width: `${Math.max((value / max) * 100, value > 0 ? 1 : 0)}%`,
            background: color,
          }}
        />
      </div>
      <div className="w-16 shrink-0 text-right text-[11px] tabular-nums text-(--renki-fg-muted)">
        {formatCount(value)}
      </div>
    </div>
  );
}

function RememberWhen({ data }: { data: InsightsResponse }) {
  const navigate = useNavigate();
  const r = data.rememberWhen;
  if (!r) {
    return (
      <div className="rounded-xl bg-(--renki-surface) p-4 text-[11px] text-(--renki-fg-muted) shadow-(--renki-shadow-xs)">
        <div className="font-medium">Remember when</div>
        <p className="mt-2">
          Check back in a month: a session from back then shows up here.
        </p>
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={!r.session.exists}
      onClick={() =>
        navigate(`/session/${encodeURIComponent(r.session.sessionId)}`)
      }
      className="block w-full min-w-0 rounded-xl bg-(--renki-surface) p-4 text-left shadow-(--renki-shadow-xs) transition-colors enabled:hover:bg-(--renki-hover)"
    >
      <div className="text-[11px] font-medium text-(--renki-fg-muted)">
        Remember when · {r.ago}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-(--renki-fg)">
        {r.session.title ?? r.session.repoName}
      </div>
      {r.firstPrompt && (
        <p className="mt-1 line-clamp-2 text-[11px] text-(--renki-fg-muted)">
          “{r.firstPrompt}”
        </p>
      )}
      <div className="mt-1 text-[10px] text-(--renki-fg-muted)">
        {r.session.repoName} · {new Date(r.createdAt).toLocaleDateString()}
      </div>
    </button>
  );
}

function AchievementsSection({ data }: { data: InsightsResponse }) {
  const got = data.achievements.filter((a) => a.achieved).length;
  return (
    <Section title={`Achievements · ${got} of ${data.achievements.length}`}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {data.achievements.map((a) => (
          <div
            key={a.id}
            className={`rounded-xl p-3 shadow-(--renki-shadow-xs) ${a.achieved ? "bg-(--renki-surface)" : "bg-(--renki-bg-inset)"}`}
            title={a.description}
          >
            <div className="flex items-center gap-1.5">
              <span
                className={`codicon ${a.achieved ? "codicon-pass-filled text-(--renki-accent)" : "codicon-circle-large text-(--renki-fg-muted)"} text-sm`}
                aria-hidden
              />
              <span
                className={`truncate text-xs font-semibold ${a.achieved ? "text-(--renki-fg)" : "text-(--renki-fg-muted)"}`}
              >
                {a.title}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-(--renki-fg-muted)">
              {a.description}
            </p>
            {!a.achieved && a.progress != null && (
              <div
                className="mt-2 h-1 overflow-hidden rounded-full bg-(--renki-border)"
                aria-label={`${Math.round(a.progress * 100)}% there`}
              >
                <div
                  className="h-full rounded-full bg-(--renki-accent)"
                  style={{ width: `${Math.max(2, a.progress * 100)}%` }}
                />
              </div>
            )}
            <span className="sr-only">
              {a.achieved ? "Achieved" : "Not yet"}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── small parts ──────────────────────────────────────────────────────────────

type RankRow = {
  key: string;
  label: string;
  value: number;
  display?: string;
  tooltip?: string;
  mono?: boolean;
};

/**
 * A ranked list with one bar per row, all one hue: the label carries identity,
 * the bar length magnitude. Hovering a row shows its exact values.
 */
function RankList({ rows }: { rows: RankRow[] }) {
  if (rows.length === 0)
    return <p className="text-[11px] text-(--renki-fg-muted)">Nothing yet.</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="group relative flex items-center gap-2">
          {r.tooltip && (
            <div className="pointer-events-none absolute bottom-full left-28 z-10 mb-1 hidden whitespace-pre rounded-xl bg-(--renki-surface) px-2 py-1 text-[10px] text-(--renki-fg) shadow-lg group-hover:block">
              {r.tooltip}
            </div>
          )}
          <div
            className={`w-28 shrink-0 truncate text-[11px] text-(--renki-fg) ${r.mono ? "font-mono" : ""}`}
            title={r.label}
          >
            {r.label}
          </div>
          <div className="h-3 flex-1 overflow-hidden rounded-sm bg-(--renki-bg)">
            <div
              className="h-full rounded-sm"
              style={{
                width: `${Math.max((r.value / max) * 100, r.value > 0 ? 2 : 0)}%`,
                background: "var(--renki-accent)",
              }}
            />
          </div>
          <div className="w-24 shrink-0 text-right text-[11px] tabular-nums text-(--renki-fg-muted)">
            {r.display ?? formatCount(r.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Two-part horizontal bars (allowed | denied), a 2px surface gap between the parts. */
function SplitBars({
  rows,
}: {
  rows: { key: string; label: string; a: number; b: number }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.a + r.b));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="group relative flex items-center gap-2">
          <div className="pointer-events-none absolute bottom-full left-28 z-10 mb-1 hidden whitespace-pre rounded-xl bg-(--renki-surface) px-2 py-1 text-[10px] text-(--renki-fg) shadow-lg group-hover:block">
            {`${r.label}\nAllowed ${r.a} · denied ${r.b}`}
          </div>
          <div className="w-28 shrink-0 truncate text-[11px] text-(--renki-fg)">
            {r.label}
          </div>
          <div className="flex h-3 flex-1 gap-0.5 overflow-hidden rounded-sm bg-(--renki-bg)">
            {r.a > 0 && (
              <div
                className="h-full"
                style={{
                  width: `${(r.a / max) * 100}%`,
                  background: SERIES[0],
                }}
              />
            )}
            {r.b > 0 && (
              <div
                className="h-full"
                style={{
                  width: `${(r.b / max) * 100}%`,
                  background: SERIES[1],
                }}
              />
            )}
          </div>
          <div className="w-16 shrink-0 text-right text-[11px] tabular-nums text-(--renki-fg-muted)">
            {r.a}/{r.b}
          </div>
        </div>
      ))}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-(--renki-fg-muted)">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-(--renki-fg)">
        {value}
      </div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-sm border border-(--renki-border)">
      <table className="w-full text-left text-[11px]">
        <thead className="bg-(--renki-bg-elevated) text-(--renki-fg-muted)">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="px-2.5 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr:nth-child(even)]:bg-(--renki-bg-elevated)/40">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td
                  key={j}
                  className={`px-2.5 py-1 tabular-nums ${j === 0 ? "text-(--renki-fg)" : "text-(--renki-fg-muted)"}`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A file's name, with its repo when another listed file shares the name. */
export function fileLabel(
  f: { repoName: string; path: string },
  all: { repoName: string; path: string }[],
): string {
  const name = (p: string) => p.split("/").pop() ?? p;
  const clash = all.some((o) => o !== f && name(o.path) === name(f.path));
  return clash ? `${f.repoName} · ${name(f.path)}` : name(f.path);
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
