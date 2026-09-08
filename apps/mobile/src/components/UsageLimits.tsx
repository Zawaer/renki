import { formatResetTime, usageSeverity } from "@renki/client-core";
import type { AccountUsage, AccountUsageExtra, AccountUsageLimit } from "@renki/protocol";
import { StyleSheet, Text, View } from "react-native";
import { radius, type ThemeColors } from "../theme";

/**
 * A plan's usage, one card per window claude.ai reports — the phone's version
 * of the web's UsageLimits, deliberately the same shape.
 *
 * The old mobile strip showed two nameless meters ("5h", "7d") and had no idea
 * a premium model like Opus or Fable carries its OWN weekly cap, so the limit
 * most likely to stop the next prompt was invisible here.
 */

function toneFor(colors: ThemeColors, severity: string | undefined, pct: number): string {
  const level = usageSeverity(severity, pct);
  return level === "critical" ? colors.error : level === "warning" ? colors.busy : colors.ok;
}

function Bar({ pct, color, colors }: { pct: number; color: string; colors: ThemeColors }) {
  return (
    <View style={[styles.track, { backgroundColor: colors.inset }]}>
      <View style={[styles.fill, { width: `${pct}%`, backgroundColor: color }]} />
    </View>
  );
}

function LimitCard({ limit, colors }: { limit: AccountUsageLimit; colors: ThemeColors }) {
  const pct = Math.max(0, Math.min(100, limit.pct));
  const color = toneFor(colors, limit.severity, pct);
  // claude.ai sends no reset time for a window that hasn't started yet, so say
  // that rather than leaving a gap where every other card has a line.
  const reset =
    formatResetTime(limit.resetsAt) ??
    (limit.kind === "session" ? "Starts on your next prompt" : "Nothing used yet");

  return (
    <View style={[styles.card, { backgroundColor: colors.inset }]}>
      <View style={styles.cardHead}>
        <View style={styles.labelWrap}>
          <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>
            {limit.label}
          </Text>
          {limit.kind.startsWith("weekly") && (
            <Text style={[styles.badge, { color: colors.dim, backgroundColor: colors.panel }]}>Weekly</Text>
          )}
        </View>
        <Text style={[styles.pct, { color }]}>{Math.round(pct)}%</Text>
      </View>
      {limit.kind === "session" && <Text style={[styles.sub, { color: colors.dim }]}>5-hour rolling window</Text>}
      <Bar pct={pct} color={color} colors={colors} />
      <Text style={[styles.sub, { color: colors.dim }]}>{reset}</Text>
    </View>
  );
}

function formatUsdAmount(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ExtraCard({ extra, colors }: { extra: AccountUsageExtra; colors: ThemeColors }) {
  const pct = Math.max(0, Math.min(100, extra.pct));
  const color = toneFor(colors, extra.severity, pct);
  return (
    <View style={[styles.card, { backgroundColor: colors.inset }]}>
      <View style={styles.cardHead}>
        <Text style={[styles.label, { color: colors.text }]}>Extra usage</Text>
        <Text style={[styles.pct, { color }]}>{Math.round(pct)}%</Text>
      </View>
      <Text style={[styles.sub, { color: colors.dim }]}>
        {formatUsdAmount(extra.usedDollars)} / {formatUsdAmount(extra.limitDollars)} {extra.currency}
      </Text>
      <Bar pct={pct} color={color} colors={colors} />
    </View>
  );
}

/** Falls back to the two headline windows when `limits` is missing — an older daemon. */
function limitsOf(usage: AccountUsage): AccountUsageLimit[] {
  if (usage.limits?.length) return usage.limits;
  return [
    { kind: "session", label: "Session usage", model: null, pct: usage.fiveHour.pct, resetsAt: usage.fiveHour.resetsAt, severity: "", isActive: true },
    { kind: "weekly_all", label: "All models", model: null, pct: usage.sevenDay.pct, resetsAt: usage.sevenDay.resetsAt, severity: "", isActive: false },
  ];
}

export function UsageLimits({ usage, colors }: { usage: AccountUsage; colors: ThemeColors }) {
  return (
    <View style={styles.list}>
      {limitsOf(usage).map((l) => (
        <LimitCard key={`${l.kind}:${l.model ?? ""}`} limit={l} colors={colors} />
      ))}
      {usage.extra && <ExtraCard extra={usage.extra} colors={colors} />}
    </View>
  );
}

/** The single most constraining figure across every window. */
export function worstUsagePct(usage: AccountUsage | null): { pct: number; severity: "normal" | "warning" | "critical" } | null {
  if (!usage) return null;
  const all = limitsOf(usage);
  if (all.length === 0) return null;
  const worst = all.reduce((a, b) => (b.pct > a.pct ? b : a));
  return { pct: worst.pct, severity: usageSeverity(worst.severity, worst.pct) };
}

const styles = StyleSheet.create({
  list: { gap: 8 },
  card: { borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  labelWrap: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  label: { fontSize: 13, fontWeight: "600" },
  badge: { fontSize: 10, paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.xs, overflow: "hidden" },
  pct: { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  sub: { fontSize: 11 },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 3 },
});
