import type { InsightsResponse, StatsRecord, StatsResponse } from "@renki/protocol";
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
import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import Svg, { Line, Path } from "react-native-svg";
import { radius, type ThemeColors } from "../theme";
import { Bars, ChartCard, Legend, Section, SimpleTable, StatTile, type Styles } from "./statsParts";

const LINE_DAYS = 30;
const PLAN_KEY = "renki.stats.planUsdPerMonth";

type Props = { data: InsightsResponse; stats: StatsResponse; colors: ThemeColors; styles: Styles; onOpenSession: (id: string) => void };

/**
 * The Stats screen past cost and tokens — mobile mirror of the web's
 * Insights. Web's hover readouts become taps here: tap a heatmap cell, a bar
 * or a month to see its numbers.
 */
export function Insights(props: Props) {
  const x = useMemo(() => makeInsightStyles(props.colors), [props.colors]);
  const p = { ...props, x };
  return (
    <>
      <Habits {...p} />
      <Code {...p} />
      <ClaudesWork {...p} />
      <Approvals {...p} />
      <Limits {...p} />
      <ModelShareSection {...p} />
      <Records {...p} />
      <Achievements {...p} />
    </>
  );
}

type P = Props & { x: InsightStyles };

function Habits({ data, colors, styles, x }: P) {
  const peak = busiestHour(data.heatmap);
  return (
    <Section
      title="Your habits"
      styles={styles}
      table={<SimpleTable headers={["", ...Array.from({ length: 24 }, (_, h) => String(h))]} rows={data.heatmap.map((r, i) => [WEEKDAYS[i]!, ...r.map(String)])} colors={colors} styles={styles} />}
    >
      <View style={styles.tiles}>
        <StatTile label="Current streak" value={days(data.streak.current)} styles={styles} />
        <StatTile label="Longest streak" value={days(data.streak.longest)} styles={styles} />
        <StatTile label="Days active" value={formatCount(data.streak.activeDays)} styles={styles} />
        <StatTile label="Prompts sent" value={formatCount(data.prompts.count)} styles={styles} />
        <StatTile label="Typical prompt" value={`${formatCount(data.prompts.medianChars)} chars`} styles={styles} />
        <StatTile label="Steered mid-turn" value={formatCount(data.prompts.steered)} styles={styles} />
      </View>
      <ChartCard title="When you work" styles={styles}>
        <Heatmap heatmap={data.heatmap} colors={colors} x={x} />
        <Text style={[styles.muted, { marginTop: 8 }]}>
          {peak ? `Busiest: ${WEEKDAYS[peak.weekday]} ${formatHourRange(peak.hour)}, ${peak.turns} turns. ` : ""}Tap a square for its count.
        </Text>
      </ChartCard>
      {data.repoStreaks.length > 0 && (
        <ChartCard title="Streaks by repo" styles={styles}>
          <RankList
            x={x}
            colors={colors}
            rows={data.repoStreaks.map((r) => ({ key: r.repoName, label: r.repoName, value: r.longest, display: `${r.current > 0 ? `${r.current} now · ` : ""}${r.longest} best` }))}
          />
        </ChartCard>
      )}
    </Section>
  );
}

/** Turns per weekday and hour: one hue, stronger with more turns. */
function Heatmap({ heatmap, colors, x }: { heatmap: number[][]; colors: ThemeColors; x: InsightStyles }) {
  const [active, setActive] = useState<{ weekday: number; hour: number } | null>(null);
  const max = Math.max(1, ...heatmap.flat());
  const n = active ? heatmap[active.weekday]![active.hour]! : 0;
  return (
    <View>
      <Text style={x.readout}>{active ? `${WEEKDAYS[active.weekday]} ${formatHourRange(active.hour)} · ${n} turn${n === 1 ? "" : "s"}` : " "}</Text>
      {heatmap.map((row, weekday) => (
        <View key={weekday} style={x.heatRow}>
          <Text style={x.heatLabel}>{WEEKDAYS[weekday]}</Text>
          {row.map((turns, hour) => {
            const on = active?.weekday === weekday && active.hour === hour;
            return (
              <Pressable
                key={hour}
                onPress={() => setActive(on ? null : { weekday, hour })}
                hitSlop={2}
                style={[
                  x.heatCell,
                  { backgroundColor: turns === 0 ? colors.inset : colors.accent, opacity: turns === 0 ? 1 : 0.2 + (turns / max) * 0.8 },
                  on && { borderWidth: 1.5, borderColor: colors.text },
                ]}
                accessibilityLabel={`${WEEKDAYS[weekday]} ${formatHourRange(hour)}: ${turns} turns`}
              />
            );
          })}
        </View>
      ))}
      <View style={x.heatRow}>
        <Text style={x.heatLabel} />
        {Array.from({ length: 24 }, (_, h) => (
          <Text key={h} style={x.heatAxis}>
            {h % 6 === 0 ? h : ""}
          </Text>
        ))}
      </View>
    </View>
  );
}

function Code({ data, colors, styles, x }: P) {
  const lines = recentLines(LINE_DAYS, data.linesDaily);
  const added = data.linesDaily.reduce((s, d) => s + d.added, 0);
  const removed = data.linesDaily.reduce((s, d) => s + d.removed, 0);
  if (added + removed === 0 && data.git.commits === 0) return null;
  return (
    <Section
      title="Code"
      styles={styles}
      table={
        <SimpleTable
          headers={["File", "Repo", "Edits", "Added", "Removed"]}
          rows={data.topFiles.map((f) => [f.path, f.repoName, String(f.edits), `+${f.added}`, `−${f.removed}`])}
          colors={colors}
          styles={styles}
        />
      }
    >
      <View style={styles.tiles}>
        <StatTile label="Lines added" value={formatCount(added)} styles={styles} />
        <StatTile label="Lines removed" value={formatCount(removed)} styles={styles} />
        <StatTile label="Commits" value={formatCount(data.git.commits)} styles={styles} />
        <StatTile label="Files touched" value={formatCount(data.filesTouched)} styles={styles} />
      </View>
      <ChartCard title={`Lines changed, last ${LINE_DAYS} days`} styles={styles}>
        <Legend items={[{ label: "Added", color: colors.series1 }, { label: "Removed", color: colors.series2 }]} styles={styles} />
        <Bars
          items={lines.map((d) => ({ key: d.day, label: formatDayLabel(d.day), a: d.added, b: d.removed, tooltip: `${formatDayLabel(d.day)} — +${formatCount(d.added)} · −${formatCount(d.removed)}` }))}
          colorA={colors.series1}
          colorB={colors.series2}
          colors={colors}
          styles={styles}
        />
      </ChartCard>
      <ChartCard title="Most edited files" styles={styles}>
        <RankList x={x} colors={colors} rows={data.topFiles.map((f) => ({ key: `${f.repoName}/${f.path}`, label: fileLabel(f, data.topFiles), value: f.edits }))} />
      </ChartCard>
      <Text style={styles.footnote}>
        Merges {formatCount(data.git.merges)} · pushes {formatCount(data.git.pushes)}. Counted from Claude's own edits and git commands.
      </Text>
    </Section>
  );
}

function ClaudesWork({ data, colors, styles, x }: P) {
  const o = data.outcomes;
  const total = o.ok + o.stopped + o.limited + o.restarted + o.errored;
  return (
    <Section
      title="Claude's work"
      styles={styles}
      table={<SimpleTable headers={["Tool", "Calls", "Failed"]} rows={data.tools.map((t) => [t.name, formatCount(t.count), formatCount(t.failed)])} colors={colors} styles={styles} />}
    >
      <View style={styles.tiles}>
        <StatTile label="Tool calls" value={formatCount(data.tools.reduce((s, t) => s + t.count, 0))} styles={styles} />
        <StatTile label="Agents launched" value={formatCount(data.agents.count)} styles={styles} />
        <StatTile label="In the background" value={formatCount(data.agents.background)} styles={styles} />
        <StatTile label="Typical agent run" value={data.agents.medianDurationMs != null ? formatDuration(data.agents.medianDurationMs) : "—"} styles={styles} />
        <StatTile label="Hands-off time" value={formatDuration(data.handsOff.handsOffMs)} styles={styles} />
        <StatTile label="Of turn time" value={formatShare(data.handsOff.handsOffMs, data.handsOff.turnMs)} styles={styles} />
      </View>
      <ChartCard title="Tools" styles={styles}>
        <RankList x={x} colors={colors} rows={data.tools.slice(0, 10).map((t) => ({ key: t.name, label: t.name, value: t.count }))} />
      </ChartCard>
      <ChartCard title="Shell commands" styles={styles}>
        <RankList x={x} colors={colors} mono rows={data.shellCommands.map((c) => ({ key: c.key, label: c.key, value: c.count }))} />
      </ChartCard>
      <ChartCard title="Speed, output tokens a minute" styles={styles}>
        <RankList
          x={x}
          colors={colors}
          rows={data.speed.map((s) => {
            const tpm = tokensPerMinute(s) ?? 0;
            return { key: s.model, label: formatModelLabel(s.model), value: tpm };
          })}
        />
      </ChartCard>
      <ChartCard title="How turns ended" styles={styles}>
        <RankList
          x={x}
          colors={colors}
          rows={[
            { key: "ok", label: "Finished", value: o.ok },
            { key: "stopped", label: "Stopped by you", value: o.stopped },
            { key: "limited", label: "Hit a limit", value: o.limited },
            { key: "restarted", label: "Cut by a restart", value: o.restarted },
            { key: "errored", label: "Errored", value: o.errored },
          ].map((r) => ({ ...r, display: `${formatCount(r.value)} · ${formatShare(r.value, total)}` }))}
        />
      </ChartCard>
      {data.agents.byType.length > 0 && (
        <ChartCard title="Agent types" styles={styles}>
          <RankList x={x} colors={colors} rows={data.agents.byType.map((t) => ({ key: t.key, label: t.key, value: t.count }))} />
        </ChartCard>
      )}
      <View style={styles.tiles}>
        <StatTile label="Compactions" value={formatCount(data.compactions.count)} styles={styles} />
        <StatTile label="Typical size" value={data.compactions.avgPreTokens != null ? formatTokenCount(data.compactions.avgPreTokens) : "—"} styles={styles} />
      </View>
      <Text style={styles.footnote}>
        {data.handsOff.since != null
          ? `Hands-off time is turn time with no device connected, counted since ${new Date(data.handsOff.since).toLocaleDateString()}, like compactions.`
          : "Hands-off time and compactions are counted from this update on."}
      </Text>
    </Section>
  );
}

function Approvals({ data, colors, styles, x }: P) {
  const a = data.approvals;
  if (a.count === 0) return null;
  return (
    <Section
      title="Approvals"
      styles={styles}
      table={<SimpleTable headers={["Tool", "Allowed", "Denied"]} rows={a.byTool.map((t) => [t.tool, String(t.allowed), String(t.denied)])} colors={colors} styles={styles} />}
    >
      <View style={styles.tiles}>
        <StatTile label="Requests" value={formatCount(a.count)} styles={styles} />
        <StatTile label="Allowed" value={formatShare(a.allowed, a.allowed + a.denied)} styles={styles} />
        <StatTile label="Unanswered" value={formatCount(a.unanswered)} styles={styles} />
        <StatTile label="Typical answer time" value={a.medianResponseMs != null ? formatDuration(a.medianResponseMs) : "—"} styles={styles} />
      </View>
      <ChartCard title="Answered from" styles={styles}>
        <RankList
          x={x}
          colors={colors}
          rows={a.byDevice.map((d) => ({
            key: d.key,
            label: formatClientTypeLabel(d.key),
            value: d.count,
            display: `${formatCount(d.count)}${d.medianResponseMs != null ? ` · ${formatDuration(d.medianResponseMs)}` : ""}`,
          }))}
        />
      </ChartCard>
      <ChartCard title="By tool" styles={styles}>
        <Legend items={[{ label: "Allowed", color: colors.series1 }, { label: "Denied", color: colors.series2 }]} styles={styles} />
        <View style={{ gap: 8 }}>
          {a.byTool.map((t) => {
            const max = Math.max(1, ...a.byTool.map((b) => b.allowed + b.denied));
            return (
              <View key={t.tool} style={x.rankRow}>
                <Text style={x.rankLabel} numberOfLines={1}>
                  {t.tool}
                </Text>
                <View style={[x.rankTrack, { gap: 2 }]}>
                  {t.allowed > 0 && <View style={{ width: `${(t.allowed / max) * 100}%`, backgroundColor: colors.series1 }} />}
                  {t.denied > 0 && <View style={{ width: `${(t.denied / max) * 100}%`, backgroundColor: colors.series2 }} />}
                </View>
                <Text style={x.rankValue}>
                  {t.allowed}/{t.denied}
                </Text>
              </View>
            );
          })}
        </View>
      </ChartCard>
    </Section>
  );
}

function Limits({ data, stats, colors, styles, x }: P) {
  const [plan, setPlan] = useState<string>("");
  useEffect(() => {
    SecureStore.getItemAsync(PLAN_KEY)
      .then((v) => v && setPlan(v))
      .catch(() => {});
  }, []);
  const onPlan = (v: string) => {
    const clean = v.replace(/[^0-9.]/g, "");
    setPlan(clean);
    (clean ? SecureStore.setItemAsync(PLAN_KEY, clean) : SecureStore.deleteItemAsync(PLAN_KEY)).catch(() => {});
  };
  const planUsd = Number(plan) > 0 ? Number(plan) : null;
  const l = data.limits;
  const months = stats.monthly.slice(-2).reverse();
  const current = new Date().toISOString().slice(0, 7);
  return (
    <Section title="Limits and value" styles={styles}>
      <View style={styles.tiles}>
        <StatTile label="Limit hits" value={formatCount(l.hits)} styles={styles} />
        <StatTile label="Time paused" value={formatDuration(l.pausedMs)} styles={styles} />
        <StatTile label="Account switches" value={formatCount(l.switches)} styles={styles} />
        <StatTile label="Read from cache" value={formatShare(data.cache.cachedInputTokens, data.cache.cachedInputTokens + data.cache.inputTokens)} styles={styles} />
      </View>
      <ChartCard title="What your plan is worth" styles={styles}>
        <Text style={styles.muted}>The same usage, priced as API calls, next to what you pay a month.</Text>
        <View style={x.planRow}>
          <Text style={styles.muted}>You pay $</Text>
          <TextInput value={plan} onChangeText={onPlan} placeholder="200" placeholderTextColor={colors.faint} keyboardType="decimal-pad" style={x.planInput} />
          <Text style={styles.muted}>a month</Text>
        </View>
        <View style={x.miniRow}>
          {months.map((m) => {
            const value = planValue(m.costUsd, planUsd);
            return (
              <View key={m.key} style={{ flex: 1 }}>
                <Text style={x.miniLabel}>
                  {formatMonthLabel(m.key)}
                  {m.key === current ? " so far" : ""}
                </Text>
                <Text style={x.miniValue}>
                  {formatCost(m.costUsd)}
                  {value ? ` · ${value}` : ""}
                </Text>
              </View>
            );
          })}
        </View>
      </ChartCard>
      {l.switchesTo.length > 0 && (
        <ChartCard title="Switched to" styles={styles}>
          <RankList x={x} colors={colors} rows={l.switchesTo.map((s) => ({ key: s.key, label: s.key === "another" ? "Another account" : `Account ${s.key}`, value: s.count }))} />
        </ChartCard>
      )}
    </Section>
  );
}

function ModelShareSection({ data, colors, styles, x }: P) {
  const share = useMemo(() => modelShare(data.modelMonthly), [data.modelMonthly]);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  if (share.months.length === 0 || share.series.length < 2) return null;
  const palette = [colors.series1, colors.series2, colors.series3, colors.series4, colors.series5];
  const H = 130;
  const n = share.months.length;
  const px = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * width);
  const paths = share.series.map((_, s) => {
    const lower = share.months.map((m) => m.shares.slice(0, s).reduce((a, b) => a + b, 0));
    const upper = share.months.map((m, i) => lower[i]! + m.shares[s]!);
    if (n === 1) {
      const x0 = width / 2 - 30;
      const x1 = width / 2 + 30;
      return `M${x0},${H - lower[0]! * H}L${x1},${H - lower[0]! * H}L${x1},${H - upper[0]! * H}L${x0},${H - upper[0]! * H}Z`;
    }
    const top = upper.map((v, i) => `${i ? "L" : "M"}${px(i)},${H - v * H}`).join("");
    const bottom = lower.map((_, i) => `L${px(n - 1 - i)},${H - lower[n - 1 - i]! * H}`).join("");
    return `${top}${bottom}Z`;
  });
  const month = active != null ? share.months[active] : null;
  return (
    <Section
      title="Models over time"
      styles={styles}
      table={
        <SimpleTable
          headers={["Month", ...share.series.map((s) => s.label)]}
          rows={share.months.map((m) => [formatMonthLabel(m.month), ...m.shares.map((v) => `${Math.round(v * 100)}%`)])}
          colors={colors}
          styles={styles}
        />
      }
    >
      <ChartCard title="Share of output tokens" styles={styles}>
        <View style={x.legendWrap}>
          {share.series.map((s, i) => (
            <View key={s.key} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: palette[i] }]} />
              <Text style={styles.muted}>{s.label}</Text>
            </View>
          ))}
        </View>
        <View
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onResponderGrant={(e) => width > 0 && setActive(n === 1 ? 0 : Math.round((e.nativeEvent.locationX / width) * (n - 1)))}
          onResponderMove={(e) => width > 0 && setActive(n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((e.nativeEvent.locationX / width) * (n - 1)))))}
          style={{ height: H }}
        >
          {width > 0 && (
            <Svg width={width} height={H}>
              {paths.map((d, i) => (
                <Path key={i} d={d} fill={palette[i]} stroke={colors.panel} strokeWidth={2} />
              ))}
              {active != null && n > 1 && <Line x1={px(active)} x2={px(active)} y1={0} y2={H} stroke={colors.text} strokeWidth={1} />}
            </Svg>
          )}
        </View>
        <View style={x.axisRow}>
          <Text style={styles.barAxisLabel}>{formatMonthLabel(share.months[0]!.month)}</Text>
          {n > 1 && <Text style={styles.barAxisLabel}>{formatMonthLabel(share.months[n - 1]!.month)}</Text>}
        </View>
        <Text style={styles.barTooltip}>
          {month ? `${formatMonthLabel(month.month)} — ${share.series.map((s, i) => `${s.label} ${Math.round(month.shares[i]! * 100)}%`).join(" · ")}` : "Touch the chart for a month's split."}
        </Text>
      </ChartCard>
    </Section>
  );
}

function Records({ data, colors, styles, x, onOpenSession }: P) {
  const r = data.records;
  const w = data.words;
  const max = Math.max(w.claudes, w.yours, 1);
  const rw = data.rememberWhen;
  return (
    <Section title="Records" styles={styles}>
      <RecordRow label="Longest turn" record={data.longestTurn} value={formatDuration} x={x} colors={colors} onOpen={onOpenSession} />
      <RecordRow label="Longest session" record={data.longestSession} value={(v) => `${formatDuration(v)} of turns`} x={x} colors={colors} onOpen={onOpenSession} />
      <RecordRow label="Most expensive turn" record={r.mostExpensiveTurn} value={formatCost} x={x} colors={colors} onOpen={onOpenSession} />
      <RecordRow label="Most tool calls in a turn" record={r.mostToolsInTurn} value={(v) => `${formatCount(v)} calls`} x={x} colors={colors} onOpen={onOpenSession} />
      <RecordRow label="Most files in a session" record={r.mostFilesInSession} value={(v) => `${formatCount(v)} files`} x={x} colors={colors} onOpen={onOpenSession} />
      <View style={styles.tiles}>
        <StatTile label="Busiest day" value={r.busiestDay ? `${r.busiestDay.turns} turns` : "—"} styles={styles} />
        <StatTile label="Most at once" value={r.mostAtOnce ? `${r.mostAtOnce.count} turns` : "—"} styles={styles} />
      </View>
      <ChartCard title="Words written" styles={styles}>
        {[
          { label: "Claude", value: w.claudes, color: colors.series1 },
          { label: "You", value: w.yours, color: colors.series2 },
        ].map((b) => (
          <View key={b.label} style={[x.rankRow, { marginBottom: 6 }]}>
            <Text style={[x.rankLabel, { width: 50 }]}>{b.label}</Text>
            <View style={x.rankTrack}>
              <View style={{ width: `${Math.max((b.value / max) * 100, b.value > 0 ? 1 : 0)}%`, backgroundColor: b.color }} />
            </View>
            <Text style={x.rankValue}>{formatCount(b.value)}</Text>
          </View>
        ))}
        {w.yours > 0 && <Text style={styles.muted}>Claude wrote {Math.max(1, Math.round(w.claudes / w.yours))} words for every one of yours.</Text>}
      </ChartCard>
      {rw ? (
        <TouchableOpacity disabled={!rw.session.exists} onPress={() => onOpenSession(rw.session.sessionId)} style={styles.chartCard} activeOpacity={0.7}>
          <Text style={styles.chartTitle}>Remember when · {rw.ago}</Text>
          <Text style={x.recordValue} numberOfLines={1}>
            {rw.session.title ?? rw.session.repoName}
          </Text>
          {rw.firstPrompt && (
            <Text style={[styles.muted, { marginTop: 4 }]} numberOfLines={3}>
              “{rw.firstPrompt}”
            </Text>
          )}
          <Text style={[styles.footnote, { marginTop: 4 }]}>
            {rw.session.repoName} · {new Date(rw.createdAt).toLocaleDateString()}
          </Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>Remember when</Text>
          <Text style={styles.muted}>Check back in a month: a session from back then shows up here.</Text>
        </View>
      )}
    </Section>
  );
}

function RecordRow({ label, record, value, x, colors, onOpen }: { label: string; record: StatsRecord | null; value: (v: number) => string; x: InsightStyles; colors: ThemeColors; onOpen: (id: string) => void }) {
  const linkable = !!record?.session.exists;
  return (
    <TouchableOpacity disabled={!linkable} onPress={() => record && onOpen(record.session.sessionId)} style={x.record} activeOpacity={0.7}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={x.miniLabel}>{label}</Text>
        <Text style={x.recordValue}>{record ? value(record.value) : "—"}</Text>
        {record && (
          <Text style={x.recordSub} numberOfLines={1}>
            {record.session.title ?? record.session.repoName} · {new Date(record.ts).toLocaleDateString()}
          </Text>
        )}
      </View>
      {linkable && <Ionicons name="chevron-forward" size={16} color={colors.faint} />}
    </TouchableOpacity>
  );
}

function Achievements({ data, colors, styles, x }: P) {
  const got = data.achievements.filter((a) => a.achieved).length;
  return (
    <Section title={`Achievements · ${got} of ${data.achievements.length}`} styles={styles}>
      <View style={styles.tiles}>
        {data.achievements.map((a) => (
          <View key={a.id} style={[x.achievement, !a.achieved && { backgroundColor: colors.inset }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name={a.achieved ? "checkmark-circle" : "ellipse-outline"} size={15} color={a.achieved ? colors.accent : colors.faint} />
              <Text style={[x.achievementTitle, !a.achieved && { color: colors.faint }]} numberOfLines={1}>
                {a.title}
              </Text>
            </View>
            <Text style={[styles.muted, { fontSize: 11, marginTop: 3 }]}>{a.description}</Text>
            {!a.achieved && a.progress != null && (
              <View style={x.progressTrack}>
                <View style={{ width: `${Math.max(2, a.progress * 100)}%`, height: "100%", backgroundColor: colors.accent, borderRadius: 2 }} />
              </View>
            )}
          </View>
        ))}
      </View>
    </Section>
  );
}

type RankRow = { key: string; label: string; value: number; display?: string };

/** A ranked list, all one hue: the label names it, the bar sizes it. */
function RankList({ rows, colors, x, mono }: { rows: RankRow[]; colors: ThemeColors; x: InsightStyles; mono?: boolean }) {
  if (rows.length === 0) return <Text style={x.miniLabel}>Nothing yet.</Text>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <View style={{ gap: 8 }}>
      {rows.map((r) => (
        <View key={r.key} style={x.rankRow}>
          <Text style={[x.rankLabel, mono && x.mono]} numberOfLines={1}>
            {r.label}
          </Text>
          <View style={x.rankTrack}>
            <View style={{ width: `${Math.max((r.value / max) * 100, r.value > 0 ? 2 : 0)}%`, backgroundColor: colors.accent, borderRadius: 3 }} />
          </View>
          <Text style={x.rankValue} numberOfLines={1}>
            {r.display ?? formatCount(r.value)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function fileLabel(f: { repoName: string; path: string }, all: { repoName: string; path: string }[]): string {
  const name = (p: string) => p.split("/").pop() ?? p;
  return all.some((o) => o !== f && name(o.path) === name(f.path)) ? `${f.repoName} · ${name(f.path)}` : name(f.path);
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

type InsightStyles = ReturnType<typeof makeInsightStyles>;

const makeInsightStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    readout: { color: colors.text, fontSize: 11, marginBottom: 6, fontVariant: ["tabular-nums"] },
    heatRow: { flexDirection: "row", gap: 2, marginBottom: 2, alignItems: "center" },
    heatLabel: { width: 26, color: colors.faint, fontSize: 9 },
    heatCell: { flex: 1, aspectRatio: 1, borderRadius: 2 },
    heatAxis: { flex: 1, color: colors.faint, fontSize: 8, textAlign: "left" },
    rankRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    rankLabel: { width: 96, color: colors.text, fontSize: 11 },
    mono: { fontFamily: "monospace", fontSize: 10.5 },
    rankTrack: { flex: 1, height: 12, flexDirection: "row", borderRadius: radius.xs, overflow: "hidden", backgroundColor: colors.bg },
    rankValue: { width: 78, textAlign: "right", color: colors.faint, fontSize: 11, fontVariant: ["tabular-nums"] },
    planRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 },
    planInput: {
      minWidth: 64,
      color: colors.text,
      backgroundColor: colors.inputBg,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.xs,
      paddingHorizontal: 8,
      paddingVertical: 4,
      fontSize: 13,
    },
    miniRow: { flexDirection: "row", gap: 12, marginTop: 12 },
    miniLabel: { color: colors.faint, fontSize: 11 },
    miniValue: { color: colors.text, fontSize: 14, fontWeight: "700", marginTop: 2, fontVariant: ["tabular-nums"] },
    legendWrap: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 4, marginBottom: 8 },
    axisRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
    record: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.panel, borderRadius: radius.md, padding: 12 },
    recordValue: { color: colors.text, fontSize: 17, fontWeight: "700", marginTop: 2 },
    recordSub: { color: colors.faint, fontSize: 11, marginTop: 2 },
    achievement: { flexBasis: "47%", flexGrow: 1, backgroundColor: colors.panel, borderRadius: radius.md, padding: 10 },
    achievementTitle: { color: colors.text, fontSize: 12, fontWeight: "700", flexShrink: 1 },
    progressTrack: { height: 4, marginTop: 8, borderRadius: 2, backgroundColor: colors.border, overflow: "hidden" },
  });
