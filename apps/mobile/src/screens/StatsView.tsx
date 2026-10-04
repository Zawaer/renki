import type { InsightsResponse, RepoStatsBucket, RtkGainResponse, StatsBucket, StatsResponse } from "@renki/protocol";
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
  totalTokens,
} from "@renki/client-core";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useClient } from "../lib/client";
import { type ThemeColors, useTheme } from "../theme";
import { Insights } from "./Insights";
import { Bars, ChartCard, Legend, Section, SimpleTable, StatTile, type Styles, makeStyles } from "./statsParts";

const DAY_WINDOW = 14;

/**
 * Cost/token/wait-time analytics — mobile mirror of the web app's StatsView.
 * Built entirely from what the daemon already durably logs (turn_result
 * events); nothing here is billed, costUsd is the Agent SDK's own notional
 * per-turn estimate, same figure shown under each reply in SessionView.
 * Web's hover tooltips become tap-to-reveal here (no hover on touch), and its
 * side-by-side chart grid stacks into a single column for phone width.
 */
export function StatsView({ onBack, onOpenSession }: { onBack: () => void; onOpenSession: (id: string) => void }) {
  const colors = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const { rest } = useClient();
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState(false);
  const [rtk, setRtk] = useState<RtkGainResponse | null>(null);
  const [insights, setInsights] = useState<InsightsResponse | null>(null);

  const refresh = useCallback(() => {
    rest
      .getStats()
      .then((res) => {
        setData(res);
        setError(false);
      })
      .catch(() => setError(true));
    rest.getRtkGain().then(setRtk).catch(() => {});
    // Optional: a daemon from before insights answers 404, and the screen is just the cost stats.
    rest.getInsights().then(setInsights).catch(() => {});
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
        <StatsBody data={data} rtk={rtk} insights={insights} onOpenSession={onOpenSession} colors={colors} styles={styles} />
      )}
    </View>
  );
}

function StatsBody({
  data,
  rtk,
  insights,
  onOpenSession,
  colors,
  styles,
}: {
  data: StatsResponse;
  rtk: RtkGainResponse | null;
  insights: InsightsResponse | null;
  onOpenSession: (id: string) => void;
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

      {insights && <Insights data={insights} stats={data} colors={colors} styles={styles} onOpenSession={onOpenSession} />}

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

      <Text style={styles.footnote}>From `rtk gain` on the daemon host — not computed by Renki.</Text>
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
          {formatTokenCount(totalTokens(current))} tokens · {formatDuration(current.durationMs)} waited
        </Text>
      )}
    </View>
  );
}

/** Ranked horizontal bar list, one row per repo (already cost-sorted by the daemon). */
function RepoBars({ repos, metric, colors, styles }: { repos: RepoStatsBucket[]; metric: "cost" | "tokens"; colors: ThemeColors; styles: Styles }) {
  const totalFor = (r: RepoStatsBucket) => (metric === "cost" ? r.costUsd : totalTokens(r));
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
  const totalFor = (b: StatsBucket) => (metric === "cost" ? b.costUsd : totalTokens(b));
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

