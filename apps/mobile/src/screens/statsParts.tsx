import { tickIndices } from "@renki/client-core";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { radius, type ThemeColors } from "../theme";

/** The Stats screen's building blocks, shared by its sections (StatsView, Insights). */

export function Section({
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

export function ChartCard({ title, children, styles }: { title: string; children: React.ReactNode; styles: Styles }) {
  return (
    <View style={styles.chartCard}>
      <Text style={styles.chartTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function Legend({ items, styles }: { items: { label: string; color: string }[]; styles: Styles }) {
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

export function StatTile({ label, value, styles }: { label: string; value: string; styles: Styles }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
    </View>
  );
}

export type BarItem = { key: string; label: string; a: number; b?: number; tooltip: string };

/**
 * Hand-rolled bar chart (no chart library — mirrors web's). Web's hover
 * tooltip becomes tap-to-reveal here: tapping a column shows its exact-value
 * tooltip below the chart until another column is tapped or the same one is
 * tapped again.
 */
export function Bars({
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

/** Fixed-width columns in a horizontal ScrollView — the RN stand-in for an HTML table. */
export function SimpleTable({ headers, rows, colors, styles }: { headers: string[]; rows: string[][]; colors: ThemeColors; styles: Styles }) {
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
          <View key={ri} style={[styles.tableRow, ri % 2 === 1 && { backgroundColor: colors.inset }]}>
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

export type Styles = ReturnType<typeof makeStyles>;

export const makeStyles = (colors: ThemeColors) =>
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
    tableHeadRow: { flexDirection: "row", backgroundColor: colors.inset },
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
