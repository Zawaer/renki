import type { RepoStatsBucket, StatsBucket, StatsResponse } from "@crc/protocol";
import { formatTokenCount } from "@crc/client-core";
import { useCallback, useEffect, useState } from "react";
import { useClient } from "../lib/client.js";
import { Button } from "./ui.js";

const DAY_WINDOW = 14;

/**
 * Cost/token/wait-time analytics, built entirely from what the daemon already
 * durably logs (turn_result events) — nothing here is billed; costUsd is the
 * Agent SDK's own notional per-turn estimate, same as the figure shown under
 * each reply in SessionView.
 */
export function StatsView() {
  const { rest } = useClient();
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState(false);

  const refresh = useCallback(() => {
    rest
      .getStats()
      .then((res) => {
        setData(res);
        setError(false);
      })
      .catch(() => setError(true));
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (error) {
    return <CenteredNote text="Couldn't load stats — check the daemon connection." />;
  }
  if (!data) {
    return <CenteredNote text="Loading stats…" />;
  }
  if (data.lifetime.turnCount === 0) {
    return (
      <CenteredNote
        icon="codicon-graph-line"
        text="No completed turns yet."
        sub="Stats will start filling in here once you've run some prompts."
      />
    );
  }

  const days = lastNDays(DAY_WINDOW, data.daily);

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-4 text-sm font-semibold text-(--crc-fg)">Stats</h1>

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Total cost" value={formatCost(data.lifetime.costUsd)} />
        <StatTile label="Input tokens" value={formatTokenCount(data.lifetime.inputTokens)} />
        <StatTile label="Output tokens" value={formatTokenCount(data.lifetime.outputTokens)} />
        <StatTile label="Time waited" value={formatDuration(data.lifetime.durationMs)} />
        <StatTile label="Replies received" value={`${data.lifetime.turnCount}`} />
      </div>

      {data.byRepo.length > 1 && (
        <Section title="By repo" table={<RepoTable rows={data.byRepo} />}>
          <ChartCard title="Cost">
            <RepoBars repos={data.byRepo} />
          </ChartCard>
        </Section>
      )}

      <Section
        title={`Last ${DAY_WINDOW} days`}
        table={
          <DataTable
            rows={days}
            labelFor={formatDayLabel}
          />
        }
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <ChartCard title="Tokens">
            <Legend items={[{ label: "Input", color: "var(--crc-chart-input)" }, { label: "Output", color: "var(--crc-chart-output)" }]} />
            <Bars
              items={days.map((b) => ({
                key: b.key,
                label: formatDayLabel(b.key),
                a: b.inputTokens,
                b: b.outputTokens,
                tooltip: `${formatDayLabel(b.key)}\nInput ${formatTokenCount(b.inputTokens)} · Output ${formatTokenCount(b.outputTokens)}`,
              }))}
              colorA="var(--crc-chart-input)"
              colorB="var(--crc-chart-output)"
            />
          </ChartCard>
          <ChartCard title="Cost">
            <Bars
              items={days.map((b) => ({
                key: b.key,
                label: formatDayLabel(b.key),
                a: b.costUsd,
                tooltip: `${formatDayLabel(b.key)}\n${formatCost(b.costUsd)}`,
              }))}
              colorA="var(--crc-accent)"
            />
          </ChartCard>
          <ChartCard title="Time waited">
            <Bars
              items={days.map((b) => ({
                key: b.key,
                label: formatDayLabel(b.key),
                a: b.durationMs,
                tooltip: `${formatDayLabel(b.key)}\n${formatDuration(b.durationMs)}`,
              }))}
              colorA="var(--crc-accent)"
            />
          </ChartCard>
        </div>
      </Section>

      <Section
        title="By month"
        table={data.monthly.length >= 2 ? <DataTable rows={data.monthly} labelFor={formatMonthLabel} /> : undefined}
      >
        {data.monthly.length < 2 ? (
          <EarlyMonthNote monthly={data.monthly} />
        ) : (
          <div className="grid gap-6 sm:grid-cols-2">
            <ChartCard title="Tokens">
              <Legend items={[{ label: "Input", color: "var(--crc-chart-input)" }, { label: "Output", color: "var(--crc-chart-output)" }]} />
              <Bars
                items={data.monthly.map((b) => ({
                  key: b.key,
                  label: formatMonthLabel(b.key),
                  a: b.inputTokens,
                  b: b.outputTokens,
                  tooltip: `${formatMonthLabel(b.key)}\nInput ${formatTokenCount(b.inputTokens)} · Output ${formatTokenCount(b.outputTokens)}`,
                }))}
                colorA="var(--crc-chart-input)"
                colorB="var(--crc-chart-output)"
              />
            </ChartCard>
            <ChartCard title="Cost">
              <Bars
                items={data.monthly.map((b) => ({
                  key: b.key,
                  label: formatMonthLabel(b.key),
                  a: b.costUsd,
                  tooltip: `${formatMonthLabel(b.key)}\n${formatCost(b.costUsd)}`,
                }))}
                colorA="var(--crc-accent)"
              />
            </ChartCard>
          </div>
        )}
      </Section>
    </div>
  );
}

function EarlyMonthNote({ monthly }: { monthly: StatsBucket[] }) {
  const current = monthly[0];
  return (
    <div className="rounded-sm border border-(--crc-border) bg-(--crc-bg-elevated) p-4 text-xs text-(--crc-fg-muted)">
      <p>Not enough history yet for a month-over-month trend — check back after a full month or two.</p>
      {current && (
        <p className="mt-2 text-(--crc-fg)">
          {formatMonthLabel(current.key)} so far: {formatCost(current.costUsd)} ·{" "}
          {formatTokenCount(current.inputTokens + current.outputTokens)} tokens · {formatDuration(current.durationMs)} waited
        </p>
      )}
    </div>
  );
}

function Section({ title, children, table }: { title: string; children: React.ReactNode; table?: React.ReactNode }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-(--crc-fg-muted)">{title}</h2>
        {table && (
          <Button variant="ghost" className="px-2! py-0.5! text-[11px]" onClick={() => setShowTable((v) => !v)}>
            {showTable ? "Hide table" : "View as table"}
          </Button>
        )}
      </div>
      {showTable && table ? table : children}
    </section>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-sm border border-(--crc-border) bg-(--crc-bg-elevated) p-4">
      <div className="mb-2 text-[11px] font-medium text-(--crc-fg-muted)">{title}</div>
      {children}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mb-2 flex gap-3 text-[11px] text-(--crc-fg-muted)">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-(--crc-border) bg-(--crc-bg-elevated) p-3">
      <div className="text-[11px] text-(--crc-fg-muted)">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-(--crc-fg)">{value}</div>
    </div>
  );
}

type BarItem = { key: string; label: string; a: number; b?: number; tooltip: string };

/**
 * Hand-rolled bar chart (no chart library in this app). Bars ≤24px thick,
 * 4px rounded top / square baseline, a 2px surface gap between stacked
 * segments, growing from a shared baseline. A generous hover target (the
 * whole column, not just the bar) shows an exact-value tooltip — the
 * relief channel for viewers who can't rely on hue alone, alongside the
 * "view as table" toggle each section offers.
 */
function Bars({ items, colorA, colorB }: { items: BarItem[]; colorA: string; colorB?: string }) {
  const CHART_H = 96;
  const max = Math.max(1, ...items.map((i) => i.a + (i.b ?? 0)));
  const ticks = tickIndices(items.length);

  return (
    <div>
      <div className="flex items-end gap-1" style={{ height: CHART_H }}>
        {items.map((it) => {
          const total = it.a + (it.b ?? 0);
          const hA = (it.a / max) * CHART_H;
          const hB = ((it.b ?? 0) / max) * CHART_H;
          return (
            <div key={it.key} className="group relative flex h-full max-w-6 flex-1 flex-col justify-end">
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-pre rounded-sm border border-(--crc-border) bg-(--crc-bg-elevated) px-2 py-1 text-[10px] text-(--crc-fg) shadow-lg group-hover:block">
                {it.tooltip}
              </div>
              <div className="flex w-full flex-col justify-end gap-0.5" style={{ height: CHART_H }}>
                {colorB !== undefined && (it.b ?? 0) > 0 && (
                  <div className="w-full rounded-t-sm" style={{ height: Math.max(hB, 2), background: colorB }} />
                )}
                {total > 0 ? (
                  <div
                    className={`w-full ${colorB === undefined || !(it.b ?? 0) ? "rounded-t-sm" : ""}`}
                    style={{ height: Math.max(hA, 2), background: colorA }}
                  />
                ) : (
                  <div className="h-px w-full bg-(--crc-border)" />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex border-t border-(--crc-border) pt-1">
        {items.map((it, i) => (
          <div key={it.key} className="flex-1 text-center text-[9px] text-(--crc-fg-muted)">
            {ticks.has(i) ? it.label : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Ranked horizontal bar list, one row per repo (already cost-sorted by the
 * daemon). Repo names are nominal, not ordered magnitude, so every bar takes
 * the same single hue — per the categorical color rule, identity here comes
 * from the label, not from color, so coloring bars by rank would just spend
 * the identity channel re-encoding what bar length already shows.
 */
function RepoBars({ repos }: { repos: RepoStatsBucket[] }) {
  const max = Math.max(1, ...repos.map((r) => r.costUsd));
  return (
    <div className="space-y-2">
      {repos.map((r) => (
        <div key={r.repoId} className="flex items-center gap-2">
          <div className="w-28 shrink-0 truncate text-[11px] text-(--crc-fg)" title={r.repoName}>
            {r.repoName}
          </div>
          <div className="h-4 flex-1 overflow-hidden rounded-sm bg-(--crc-bg)">
            <div
              className="h-full rounded-sm"
              style={{ width: `${Math.max((r.costUsd / max) * 100, r.costUsd > 0 ? 2 : 0)}%`, background: "var(--crc-accent)" }}
            />
          </div>
          <div className="w-16 shrink-0 text-right text-[11px] text-(--crc-fg-muted) tabular-nums">{formatCost(r.costUsd)}</div>
        </div>
      ))}
    </div>
  );
}

function RepoTable({ rows }: { rows: RepoStatsBucket[] }) {
  return (
    <div className="overflow-x-auto rounded-sm border border-(--crc-border)">
      <table className="w-full text-left text-[11px]">
        <thead className="bg-(--crc-bg-elevated) text-(--crc-fg-muted)">
          <tr>
            {["Repo", "Turns", "Input", "Output", "Cost", "Time waited"].map((h) => (
              <th key={h} className="px-2.5 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr:nth-child(even)]:bg-(--crc-bg-elevated)/40">
          {rows.map((r) => (
            <tr key={r.repoId}>
              <td className="px-2.5 py-1 text-(--crc-fg)">{r.repoName}</td>
              <td className="px-2.5 py-1 tabular-nums text-(--crc-fg-muted)">{r.turnCount}</td>
              <td className="px-2.5 py-1 tabular-nums text-(--crc-fg-muted)">{formatTokenCount(r.inputTokens)}</td>
              <td className="px-2.5 py-1 tabular-nums text-(--crc-fg-muted)">{formatTokenCount(r.outputTokens)}</td>
              <td className="px-2.5 py-1 tabular-nums text-(--crc-fg-muted)">{formatCost(r.costUsd)}</td>
              <td className="px-2.5 py-1 tabular-nums text-(--crc-fg-muted)">{formatDuration(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DataTable({ rows, labelFor }: { rows: StatsBucket[]; labelFor: (key: string) => string }) {
  return (
    <div className="overflow-x-auto rounded-sm border border-(--crc-border)">
      <table className="w-full text-left text-[11px]">
        <thead className="bg-(--crc-bg-elevated) text-(--crc-fg-muted)">
          <tr>
            {["", "Turns", "Input", "Output", "Cost", "Time waited"].map((h) => (
              <th key={h} className="px-2.5 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr:nth-child(even)]:bg-(--crc-bg-elevated)/40">
          {[...rows].reverse().map((r) => (
            <tr key={r.key}>
              <td className="px-2.5 py-1 text-(--crc-fg)">{labelFor(r.key)}</td>
              <td className="px-2.5 py-1 tabular-nums text-(--crc-fg-muted)">{r.turnCount}</td>
              <td className="px-2.5 py-1 tabular-nums text-(--crc-fg-muted)">{formatTokenCount(r.inputTokens)}</td>
              <td className="px-2.5 py-1 tabular-nums text-(--crc-fg-muted)">{formatTokenCount(r.outputTokens)}</td>
              <td className="px-2.5 py-1 tabular-nums text-(--crc-fg-muted)">{formatCost(r.costUsd)}</td>
              <td className="px-2.5 py-1 tabular-nums text-(--crc-fg-muted)">{formatDuration(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CenteredNote({ icon, text, sub }: { icon?: string; text: string; sub?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-(--crc-fg-muted)">
      {icon && <span className={`codicon ${icon} text-2xl`} />}
      <p className="text-sm">{text}</p>
      {sub && <p className="max-w-xs text-xs">{sub}</p>}
    </div>
  );
}

// ── formatting & data helpers ────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec <= 0) return "0s";
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatMonthLabel(key: string): string {
  const d = new Date(`${key}-01T00:00:00Z`);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Trailing N UTC days ending today, zero-filled for days with no turns. */
function lastNDays(n: number, buckets: StatsBucket[]): StatsBucket[] {
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const now = new Date();
  const out: StatsBucket[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    out.push(byKey.get(key) ?? { key, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, turnCount: 0 });
  }
  return out;
}

/** Sparse x-axis label indices (first, last, and evenly spaced in between) so labels don't collide. */
function tickIndices(count: number, maxTicks = 6): Set<number> {
  if (count <= maxTicks) return new Set(Array.from({ length: count }, (_, i) => i));
  const step = (count - 1) / (maxTicks - 1);
  return new Set(Array.from({ length: maxTicks }, (_, i) => Math.round(i * step)));
}
