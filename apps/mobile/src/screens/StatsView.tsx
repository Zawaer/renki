import type { RepoStatsBucket, RtkGainResponse, StatsBucket, StatsResponse } from "@crc/protocol";
import {
  formatClientTypeLabel,
  formatCost,
  formatDayLabel,
  formatDuration,
  formatModelLabel,
  formatMonthLabel,
  formatSuccessRate,
  formatTokenCount,
  lastNDays,
  tickIndices,
} from "@crc/client-core";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useClient } from "../lib/client";
import { radius, type ThemeColors, useTheme } from "../theme";

const DAY_WINDOW = 14;

/**
 * Cost/token/wait-time analytics — mobile mirror of the web app's StatsView.
 * Built entirely from what the daemon already durably logs (turn_result
 * events); nothing here is billed, costUsd is the Agent SDK's own notional
 * per-turn estimate, same figure shown under each reply in SessionView.
 * Web's hover tooltips become tap-to-reveal here (no hover on touch), and its
 * side-by-side chart grid stacks into a single column for phone width.
 */
export function StatsView({ onBack }: { onBack: () => void }) {
  const colors = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const { rest } = useClient();
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState(false);
  const [rtk, setRtk] = useState<RtkGainResponse | null>(null);

  const refresh = useCallback(() => {
    rest
      .getStats()
      .then((res) => {
        setData(res);
        setError(false);
      })
      .catch(() => setError(true));
    rest.getRtkGain().then(setRtk).catch(() => {});
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <View style={styles.fill}>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Stats</Text>
        <View style={{ width: 22 }} />
      </View>

      {error ? (
        <CenteredNote styles={styles} text="Couldn't load stats — check the daemon connection." />
      ) : !data ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : data.lifetime.turnCount === 0 ? (
        <ScrollView contentContainerStyle={styles.body}>
          <CenteredNote
            styles={styles}
            fill={false}
            text="No completed turns yet."
            sub="Stats will start filling in here once you've run some prompts."
          />
          {rtk?.enabled && <RtkSection rtk={rtk} colors={colors} styles={styles} />}
        </ScrollView>
      ) : (
        <StatsBody data={data} rtk={rtk} colors={colors} styles={styles} />
      )}
    </View>
  );
}

function StatsBody({
  data,
  rtk,
  colors,
  styles,
}: {
  data: StatsResponse;
  rtk: RtkGainResponse | null;
  colors: ThemeColors;
  styles: Styles;
}) {
  const days = lastNDays(DAY_WINDOW, data.daily);

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <View style={styles.tiles}>
        <StatTile label="Total cost" value={formatCost(data.lifetime.costUsd)} styles={styles} />
        <StatTile label="Input tokens" value={formatTokenCount(data.lifetime.inputTokens)} styles={styles} />
        <StatTile label="Output tokens" value={formatTokenCount(data.lifetime.outputTokens)} styles={styles} />
        <StatTile label="Time waited" value={formatDuration(data.lifetime.durationMs)} styles={styles} />
        <StatTile label="Replies received" value={`${data.lifetime.turnCount}`} styles={styles} />
        <StatTile label="Success rate" value={formatSuccessRate(data.lifetime)} styles={styles} />
      </View>

      {data.byRepo.length > 1 && (
        <Section
          title="By repo"
          styles={styles}
          table={
            <SimpleTable
              headers={["Repo", "Turns", "Success", "Input", "Output", "Cost", "Time waited"]}
              rows={data.byRepo.map((r) => [
                r.repoName,
                `${r.turnCount}`,
                formatSuccessRate(r),
                formatTokenCount(r.inputTokens),
                formatTokenCount(r.outputTokens),
                formatCost(r.costUsd),
                formatDuration(r.durationMs),
              ])}
              colors={colors}
              styles={styles}
            />
          }
        >
          <ChartCard title="Tokens" styles={styles}>
            <Legend items={[{ label: "Input", color: colors.chartInput }, { label: "Output", color: colors.chartOutput }]} styles={styles} />
            <RepoBars repos={data.byRepo} metric="tokens" colors={colors} styles={styles} />
          </ChartCard>
          <ChartCard title="Cost" styles={styles}>
            <RepoBars repos={data.byRepo} metric="cost" colors={colors} styles={styles} />
          </ChartCard>
        </Section>
      )}

      {data.byModel.length > 1 && (
        <Section
          title="By model"
          styles={styles}
          table={
            <SimpleTable
              headers={["Model", "Turns", "Success", "Input", "Output", "Cost", "Time waited"]}
              rows={data.byModel.map((b) => [
                formatModelLabel(b.key),
                `${b.turnCount}`,
                formatSuccessRate(b),
                formatTokenCount(b.inputTokens),
                formatTokenCount(b.outputTokens),
                formatCost(b.costUsd),
                formatDuration(b.durationMs),
              ])}
              colors={colors}
              styles={styles}
            />
          }
        >
          <ChartCard title="Tokens" styles={styles}>
            <Legend items={[{ label: "Input", color: colors.chartInput }, { label: "Output", color: colors.chartOutput }]} styles={styles} />
            <CategoryBars buckets={data.byModel} metric="tokens" labelFor={formatModelLabel} colors={colors} styles={styles} />
          </ChartCard>
          <ChartCard title="Cost" styles={styles}>
            <CategoryBars buckets={data.byModel} metric="cost" labelFor={formatModelLabel} colors={colors} styles={styles} />
          </ChartCard>
        </Section>
      )}

      {data.byClientType.length > 1 && (
        <Section
          title="By client"
          styles={styles}
          table={
            <SimpleTable
              headers={["Client", "Turns", "Success", "Input", "Output", "Cost", "Time waited"]}
              rows={data.byClientType.map((b) => [
                formatClientTypeLabel(b.key),
                `${b.turnCount}`,
                formatSuccessRate(b),
                formatTokenCount(b.inputTokens),
                formatTokenCount(b.outputTokens),
                formatCost(b.costUsd),
                formatDuration(b.durationMs),
              ])}
              colors={colors}
              styles={styles}
            />
          }
        >
          <ChartCard title="Tokens" styles={styles}>
            <Legend items={[{ label: "Input", color: colors.chartInput }, { label: "Output", color: colors.chartOutput }]} styles={styles} />
            <CategoryBars buckets={data.byClientType} metric="tokens" labelFor={formatClientTypeLabel} colors={colors} styles={styles} />
          </ChartCard>
          <ChartCard title="Cost" styles={styles}>
            <CategoryBars buckets={data.byClientType} metric="cost" labelFor={formatClientTypeLabel} colors={colors} styles={styles} />
          </ChartCard>
        </Section>
      )}

      <Section
        title={`Last ${DAY_WINDOW} days`}
        styles={styles}
        table={
          <SimpleTable
            headers={["", "Turns", "Success", "Input", "Output", "Cost", "Time waited"]}
            rows={[...days].reverse().map((b) => [
              formatDayLabel(b.key),
              `${b.turnCount}`,
              formatSuccessRate(b),
              formatTokenCount(b.inputTokens),
              formatTokenCount(b.outputTokens),
              formatCost(b.costUsd),
              formatDuration(b.durationMs),
            ])}
            colors={colors}
            styles={styles}
          />
        }
      >
        <ChartCard title="Tokens" styles={styles}>
          <Legend items={[{ label: "Input", color: colors.chartInput }, { label: "Output", color: colors.chartOutput }]} styles={styles} />
          <Bars
            items={days.map((b) => ({
              key: b.key,
              label: formatDayLabel(b.key),
              a: b.inputTokens,
              b: b.outputTokens,
              tooltip: `${formatDayLabel(b.key)} — Input ${formatTokenCount(b.inputTokens)} · Output ${formatTokenCount(b.outputTokens)}`,
            }))}
            colorA={colors.chartInput}
            colorB={colors.chartOutput}
            colors={colors}
            styles={styles}
          />
        </ChartCard>
        <ChartCard title="Cost" styles={styles}>
          <Bars
            items={days.map((b) => ({
              key: b.key,
              label: formatDayLabel(b.key),
              a: b.costUsd,
              tooltip: `${formatDayLabel(b.key)} — ${formatCost(b.costUsd)}`,
            }))}
            colorA={colors.accent}
            colors={colors}
            styles={styles}
          />
        </ChartCard>
        <ChartCard title="Time waited" styles={styles}>
          <Bars
            items={days.map((b) => ({
              key: b.key,
              label: formatDayLabel(b.key),
              a: b.durationMs,
              tooltip: `${formatDayLabel(b.key)} — ${formatDuration(b.durationMs)}`,
            }))}
            colorA={colors.accent}
            colors={colors}
            styles={styles}
          />
        </ChartCard>
      </Section>

      <Section
        title="By month"
        styles={styles}
        table={
          data.monthly.length >= 2 ? (
            <SimpleTable
              headers={["", "Turns", "Success", "Input", "Output", "Cost", "Time waited"]}
              rows={[...data.monthly].reverse().map((b) => [
                formatMonthLabel(b.key),
                `${b.turnCount}`,
                formatSuccessRate(b),
                formatTokenCount(b.inputTokens),
                formatTokenCount(b.outputTokens),
                formatCost(b.costUsd),
                formatDuration(b.durationMs),
              ])}
              colors={colors}
              styles={styles}
            />
          ) : undefined
        }
      >
        {data.monthly.length < 2 ? (
          <EarlyMonthNote monthly={data.monthly} colors={colors} styles={styles} />
        ) : (
          <>
            <ChartCard title="Tokens" styles={styles}>
              <Legend items={[{ label: "Input", color: colors.chartInput }, { label: "Output", color: colors.chartOutput }]} styles={styles} />
              <Bars
                items={data.monthly.map((b) => ({
                  key: b.key,
                  label: formatMonthLabel(b.key),
                  a: b.inputTokens,
                  b: b.outputTokens,
                  tooltip: `${formatMonthLabel(b.key)} — Input ${formatTokenCount(b.inputTokens)} · Output ${formatTokenCount(b.outputTokens)}`,
                }))}
                colorA={colors.chartInput}
                colorB={colors.chartOutput}
                colors={colors}
                styles={styles}
              />
            </ChartCard>
            <ChartCard title="Cost" styles={styles}>
              <Bars
                items={data.monthly.map((b) => ({
                  key: b.key,
                  label: formatMonthLabel(b.key),
                  a: b.costUsd,
                  tooltip: `${formatMonthLabel(b.key)} — ${formatCost(b.costUsd)}`,
                }))}
                colorA={colors.accent}
                colors={colors}
                styles={styles}
              />
            </ChartCard>
          </>
        )}
      </Section>

      {rtk?.enabled && <RtkSection rtk={rtk} colors={colors} styles={styles} />}
    </ScrollView>
  );
}

function RtkSection({ rtk, colors, styles }: { rtk: RtkGainResponse; colors: ThemeColors; styles: Styles }) {
  if (!rtk.available || !rtk.summary) {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>RTK savings</Text>
        <Text style={styles.muted}>RTK is enabled but not reachable on the daemon host{rtk.error ? ` — ${rtk.error}` : ""}.</Text>
      </View>
    );
  }

  const { summary, daily } = rtk;

  return (
    <Section
      title="RTK savings"
      styles={styles}
      table={
        daily.length > 0 ? (
          <SimpleTable
            headers={["", "Commands", "Input", "Output", "Saved", "Savings %", "Exec time"]}
            rows={[...daily].reverse().map((d) => [
              formatDayLabel(d.date),
              `${d.commands}`,
              formatTokenCount(d.inputTokens),
              formatTokenCount(d.outputTokens),
              formatTokenCount(d.savedTokens),
              `${Math.round(d.savingsPct)}%`,
              formatDuration(d.totalTimeMs),
            ])}
            colors={colors}
            styles={styles}
          />
        ) : undefined
      }
    >
      <View style={styles.tiles}>
        <StatTile label="Commands" value={String(summary.totalCommands)} styles={styles} />
        <StatTile label="Tokens saved" value={formatTokenCount(summary.totalSavedTokens)} styles={styles} />
        <StatTile label="Avg savings" value={`${Math.round(summary.avgSavingsPct)}%`} styles={styles} />
        <StatTile label="Exec time" value={formatDuration(summary.totalTimeMs)} styles={styles} />
      </View>

      {daily.length > 0 && (
        <>
          <ChartCard title="Tokens saved" styles={styles}>
            <Bars
              items={daily.map((d) => ({
                key: d.date,
                label: formatDayLabel(d.date),
                a: d.savedTokens,
                tooltip: `${formatDayLabel(d.date)} — ${formatTokenCount(d.savedTokens)} saved · ${Math.round(d.savingsPct)}%`,
              }))}
              colorA={colors.accent}
              colors={colors}
              styles={styles}
            />
          </ChartCard>
          <ChartCard title="Savings %" styles={styles}>
            <Bars
              items={daily.map((d) => ({
                key: d.date,
                label: formatDayLabel(d.date),
                a: d.savingsPct,
                tooltip: `${formatDayLabel(d.date)} — ${Math.round(d.savingsPct)}% savings · ${d.commands} cmd${d.commands === 1 ? "" : "s"}`,
              }))}
              colorA={colors.accent}
              colors={colors}
              styles={styles}
            />
          </ChartCard>
        </>
      )}

      <Text style={styles.footnote}>From `rtk gain` on the daemon host — not computed by CRC.</Text>
    </Section>
  );
}

function EarlyMonthNote({ monthly, colors, styles }: { monthly: StatsBucket[]; colors: ThemeColors; styles: Styles }) {
  const current = monthly[0];
  return (
    <View style={styles.note}>
      <Text style={styles.muted}>Not enough history yet for a month-over-month trend — check back after a full month or two.</Text>
      {current && (
        <Text style={[styles.muted, { color: colors.text, marginTop: 6 }]}>
          {formatMonthLabel(current.key)} so far: {formatCost(current.costUsd)} ·{" "}
          {formatTokenCount(current.inputTokens + current.outputTokens)} tokens · {formatDuration(current.durationMs)} waited
        </Text>
      )}
    </View>
  );
}

function Section({
  title,
  children,
  table,
  styles,
}: {
  title: string;
  children: React.ReactNode;
  table?: React.ReactNode;
  styles: Styles;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {table && (
          <TouchableOpacity onPress={() => setShowTable((v) => !v)}>
            <Text style={styles.link}>{showTable ? "Hide table" : "View as table"}</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={{ gap: 12 }}>{showTable && table ? table : children}</View>
    </View>
  );
}

function ChartCard({ title, children, styles }: { title: string; children: React.ReactNode; styles: Styles }) {
  return (
    <View style={styles.chartCard}>
      <Text style={styles.chartTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Legend({ items, styles }: { items: { label: string; color: string }[]; styles: Styles }) {
  return (
    <View style={styles.legend}>
      {items.map((it) => (
        <View key={it.label} style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: it.color }]} />
          <Text style={styles.muted}>{it.label}</Text>
        </View>
      ))}
    </View>
  );
}

function StatTile({ label, value, styles }: { label: string; value: string; styles: Styles }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
    </View>
  );
}

type BarItem = { key: string; label: string; a: number; b?: number; tooltip: string };

/**
 * Hand-rolled bar chart (no chart library — mirrors web's). Web's hover
 * tooltip becomes tap-to-reveal here: tapping a column shows its exact-value
 * tooltip below the chart until another column is tapped or the same one is
 * tapped again.
 */
function Bars({
  items,
  colorA,
  colorB,
  colors,
  styles,
}: {
  items: BarItem[];
  colorA: string;
  colorB?: string;
  colors: ThemeColors;
  styles: Styles;
}) {
  const CHART_H = 96;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const max = Math.max(1, ...items.map((i) => i.a + (i.b ?? 0)));
  // 5, not web's 6 — mobile's narrower screen collides sooner.
  const ticks = tickIndices(items.length, 5);
  const active = items.find((i) => i.key === activeKey);

  return (
    <View>
      <View style={[styles.barsRow, { height: CHART_H }]}>
        {items.map((it) => {
          const total = it.a + (it.b ?? 0);
          const hA = (it.a / max) * CHART_H;
          const hB = ((it.b ?? 0) / max) * CHART_H;
          return (
            <TouchableOpacity
              key={it.key}
              style={styles.barCol}
              activeOpacity={0.7}
              onPress={() => setActiveKey((k) => (k === it.key ? null : it.key))}
            >
              <View style={[styles.barColInner, { height: CHART_H }]}>
                {colorB !== undefined && (it.b ?? 0) > 0 && (
                  <View style={[styles.barSeg, { height: Math.max(hB, 2), backgroundColor: colorB }]} />
                )}
                {total > 0 ? (
                  <View style={[styles.barSeg, { height: Math.max(hA, 2), backgroundColor: colorA }]} />
                ) : (
                  <View style={[styles.barZero, { backgroundColor: colors.border }]} />
                )}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={styles.barAxis}>
        {items.map((it, i) => (
          <Text key={it.key} style={styles.barAxisLabel}>
            {ticks.has(i) ? it.label : ""}
          </Text>
        ))}
      </View>
      {active && <Text style={styles.barTooltip}>{active.tooltip}</Text>}
    </View>
  );
}

/** Ranked horizontal bar list, one row per repo (already cost-sorted by the daemon). */
function RepoBars({ repos, metric, colors, styles }: { repos: RepoStatsBucket[]; metric: "cost" | "tokens"; colors: ThemeColors; styles: Styles }) {
  const totalFor = (r: RepoStatsBucket) => (metric === "cost" ? r.costUsd : r.inputTokens + r.outputTokens);
  const max = Math.max(1, ...repos.map(totalFor));
  return (
    <View style={{ gap: 8 }}>
      {repos.map((r) => {
        const total = totalFor(r);
        const pct = Math.max((total / max) * 100, total > 0 ? 2 : 0);
        return (
          <View key={r.repoId} style={styles.repoRow}>
            <Text style={styles.repoName} numberOfLines={1}>
              {r.repoName}
            </Text>
            <View style={styles.repoTrack}>
              {metric === "tokens" ? (
                <>
                  <View style={{ width: `${(r.inputTokens / max) * 100}%`, height: "100%", backgroundColor: colors.chartInput }} />
                  <View style={{ width: `${(r.outputTokens / max) * 100}%`, height: "100%", backgroundColor: colors.chartOutput }} />
                </>
              ) : (
                <View style={{ width: `${pct}%`, height: "100%", backgroundColor: colors.accent }} />
              )}
            </View>
            <Text style={styles.repoValue}>{metric === "cost" ? formatCost(total) : formatTokenCount(total)}</Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Ranked horizontal bar list keyed on a plain `StatsBucket` (model/client-type
 * buckets, unlike repos, have no separate id/display-name pair — the key
 * itself, run through `labelFor`, is the label). Same proportions as `RepoBars`.
 */
function CategoryBars({
  buckets,
  metric,
  labelFor,
  colors,
  styles,
}: {
  buckets: StatsBucket[];
  metric: "cost" | "tokens";
  labelFor: (key: string) => string;
  colors: ThemeColors;
  styles: Styles;
}) {
  const totalFor = (b: StatsBucket) => (metric === "cost" ? b.costUsd : b.inputTokens + b.outputTokens);
  const max = Math.max(1, ...buckets.map(totalFor));
  return (
    <View style={{ gap: 8 }}>
      {buckets.map((b) => {
        const total = totalFor(b);
        const pct = Math.max((total / max) * 100, total > 0 ? 2 : 0);
        return (
          <View key={b.key} style={styles.repoRow}>
            <Text style={styles.repoName} numberOfLines={1}>
              {labelFor(b.key)}
            </Text>
            <View style={styles.repoTrack}>
              {metric === "tokens" ? (
                <>
                  <View style={{ width: `${(b.inputTokens / max) * 100}%`, height: "100%", backgroundColor: colors.chartInput }} />
                  <View style={{ width: `${(b.outputTokens / max) * 100}%`, height: "100%", backgroundColor: colors.chartOutput }} />
                </>
              ) : (
                <View style={{ width: `${pct}%`, height: "100%", backgroundColor: colors.accent }} />
              )}
            </View>
            <Text style={styles.repoValue}>{metric === "cost" ? formatCost(total) : formatTokenCount(total)}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** Fixed-width columns in a horizontal ScrollView — the RN stand-in for an HTML table. */
function SimpleTable({ headers, rows, colors, styles }: { headers: string[]; rows: string[][]; colors: ThemeColors; styles: Styles }) {
  const colWidth = (i: number) => (i === 0 ? 110 : 74);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={styles.tableWrap}>
      <View>
        <View style={styles.tableHeadRow}>
          {headers.map((h, i) => (
            <Text key={i} style={[styles.tableHeadCell, { width: colWidth(i) }]}>
              {h}
            </Text>
          ))}
        </View>
        {rows.map((row, ri) => (
          <View key={ri} style={[styles.tableRow, ri % 2 === 1 && { backgroundColor: colors.panel2 }]}>
            {row.map((cell, ci) => (
              <Text key={ci} style={[styles.tableCell, { width: colWidth(ci) }, ci === 0 && styles.tableCellFirst]} numberOfLines={1}>
                {cell}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function CenteredNote({
  text,
  sub,
  fill = true,
  styles,
}: {
  text: string;
  sub?: string;
  fill?: boolean;
  styles: Styles;
}) {
  return (
    <View style={fill ? styles.centerFill : styles.centerInline}>
      <Text style={styles.noteText}>{text}</Text>
      {sub && <Text style={styles.noteSub}>{sub}</Text>}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.bg },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingBottom: 14,
    },
    title: { color: colors.text, fontSize: 18, fontWeight: "700" },
    body: { padding: 16, gap: 14 },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
    tile: {
      flexBasis: "47%",
      flexGrow: 1,
      backgroundColor: colors.panel,
      borderRadius: radius.md,
      padding: 12,
    },
    tileLabel: { color: colors.faint, fontSize: 11 },
    tileValue: { color: colors.text, fontSize: 18, fontWeight: "700", marginTop: 3 },
    section: { gap: 10 },
    sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    sectionTitle: { color: colors.faint, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
    link: { color: colors.accent, fontSize: 12, fontWeight: "600" },
    muted: { color: colors.faint, fontSize: 12 },
    footnote: { color: colors.faint, fontSize: 10, marginTop: 2 },
    chartCard: { backgroundColor: colors.panel, borderRadius: radius.md, padding: 14 },
    chartTitle: { color: colors.faint, fontSize: 11, fontWeight: "600", marginBottom: 10 },
    legend: { flexDirection: "row", gap: 12, marginBottom: 8 },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
    legendDot: { width: 7, height: 7, borderRadius: 4 },
    barsRow: { flexDirection: "row", alignItems: "flex-end", gap: 3 },
    barCol: { flex: 1, height: "100%" },
    barColInner: { width: "100%", flexDirection: "column-reverse", gap: 1 },
    barSeg: { width: "100%", borderRadius: 3 },
    barZero: { width: "100%", height: 1 },
    barAxis: { flexDirection: "row", paddingTop: 6, marginTop: 6 },
    barAxisLabel: { flex: 1, textAlign: "center", color: colors.faint, fontSize: 9 },
    barTooltip: { color: colors.text, fontSize: 11, marginTop: 8, textAlign: "center" },
    repoRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    repoName: { width: 90, color: colors.text, fontSize: 11 },
    repoTrack: { flex: 1, height: 14, flexDirection: "row", borderRadius: radius.xs, overflow: "hidden", backgroundColor: colors.bg },
    repoValue: { width: 64, textAlign: "right", color: colors.faint, fontSize: 11 },
    tableWrap: { backgroundColor: colors.panel, borderRadius: radius.md, overflow: "hidden" },
    tableHeadRow: { flexDirection: "row", backgroundColor: colors.panel2 },
    tableHeadCell: { color: colors.faint, fontSize: 10, fontWeight: "600", paddingHorizontal: 10, paddingVertical: 8 },
    tableRow: { flexDirection: "row" },
    tableCell: { color: colors.faint, fontSize: 11, paddingHorizontal: 10, paddingVertical: 7, textAlign: "right" },
    tableCellFirst: { color: colors.text, textAlign: "left" },
    note: { backgroundColor: colors.panel, borderRadius: radius.md, padding: 14 },
    centerFill: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6, padding: 24 },
    centerInline: { alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 32 },
    noteText: { color: colors.faint, fontSize: 14, textAlign: "center" },
    noteSub: { color: colors.faint, fontSize: 12, textAlign: "center", maxWidth: 260 },
  });
