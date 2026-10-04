import { Ionicons } from "@expo/vector-icons";
import { type AgentNode, flattenAgents, formatTokenCount, formatTurnDuration } from "@renki/client-core";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { radius, type ThemeColors, useTheme, withAlpha } from "../theme";
import { Markdown } from "./Markdown";
import { animateLayout, PulseDot } from "./Motion";
import { Sheet } from "./Sheet";

/**
 * The phone's agent map: every subagent the session started, as a tree, with
 * what each was asked, how it ended, how long it took and what it cost.
 * `AgentsButton` is its entry point in the session header; the sheet itself
 * lists the agents and expands one to its answer.
 */

/** The header's entry point — hidden until the session has started an agent. */
export function AgentsButton({ agents, onPress }: { agents: AgentNode[]; onPress: () => void }) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const all = useMemo(() => flattenAgents(agents), [agents]);
  if (all.length === 0) return null;
  const running = all.filter((a) => a.status === "running").length;
  const label = running > 0 ? `${running} of ${all.length} agents running` : `${all.length} agents`;
  return (
    <TouchableOpacity
      style={styles.headerBtn}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name="git-network-outline" size={16} color={running > 0 ? colors.text : colors.dim} />
      <Text style={[styles.headerBtnCount, running > 0 && { color: colors.text }]}>{running > 0 ? running : all.length}</Text>
      {running > 0 && <PulseDot color={colors.ok} size={6} />}
    </TouchableOpacity>
  );
}

export function AgentsSheet({ visible, onClose, agents }: { visible: boolean; onClose: () => void; agents: AgentNode[] }) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const all = useMemo(() => flattenAgents(agents), [agents]);
  const running = all.filter((a) => a.status === "running").length;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // Running agents' durations tick from their start — only while someone is
  // looking and something is actually running.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible || running === 0) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [visible, running]);

  const toggle = (id: string) => {
    animateLayout();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const subtitle = `${all.length} ${all.length === 1 ? "agent" : "agents"}${running > 0 ? ` · ${running} running` : ""}`;

  return (
    <Sheet visible={visible} onClose={onClose} title="Agents" colors={colors}>
      <Text style={styles.subtitle}>{subtitle}</Text>
      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        {agents.length === 0 ? (
          <Text style={styles.empty}>No agents in this session.</Text>
        ) : (
          agents.map((a) => (
            <AgentTree key={a.toolUseId} node={a} now={now} expanded={expanded} onToggle={toggle} colors={colors} styles={styles} />
          ))
        )}
      </ScrollView>
    </Sheet>
  );
}

function AgentTree({
  node,
  now,
  expanded,
  onToggle,
  colors,
  styles,
}: {
  node: AgentNode;
  now: number;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  const isOpen = expanded.has(node.toolUseId);
  const meta = [node.type, durationOf(node, now), node.usage ? `${formatTokenCount(node.usage.tokens)} tokens` : null]
    .filter((p): p is string => !!p)
    .join(" · ");
  return (
    <View>
      <TouchableOpacity
        style={[styles.row, isOpen && { backgroundColor: colors.hover }]}
        onPress={() => onToggle(node.toolUseId)}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen }}
      >
        <View style={styles.dotSlot}>
          <StatusDot status={node.status} colors={colors} />
        </View>
        <View style={styles.flex1}>
          <View style={styles.labelLine}>
            <Text style={[styles.label, node.status === "stopped" && { color: colors.dim }]} numberOfLines={1}>
              {node.label}
            </Text>
            {node.background && (
              <View style={styles.tag}>
                <Text style={styles.tagText}>background</Text>
              </View>
            )}
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
            {node.status === "failed" ? " · failed" : node.status === "stopped" ? " · stopped" : ""}
          </Text>
        </View>
        <Ionicons name={isOpen ? "chevron-up" : "chevron-down"} size={14} color={colors.faint} />
      </TouchableOpacity>
      {isOpen && (
        <View style={styles.detail}>
          {node.usage && (
            <Text style={styles.detailMeta}>
              {node.usage.toolUses} tool {node.usage.toolUses === 1 ? "call" : "calls"}
            </Text>
          )}
          {node.summary ? (
            <ScrollView style={styles.summary} nestedScrollEnabled>
              <Markdown content={node.summary} />
            </ScrollView>
          ) : (
            <Text style={styles.detailMeta}>{node.status === "running" ? "Still working…" : "No answer recorded."}</Text>
          )}
        </View>
      )}
      {node.children.length > 0 && (
        <View style={styles.children}>
          {node.children.map((c) => (
            <AgentTree key={c.toolUseId} node={c} now={now} expanded={expanded} onToggle={onToggle} colors={colors} styles={styles} />
          ))}
        </View>
      )}
    </View>
  );
}

function StatusDot({ status, colors }: { status: AgentNode["status"]; colors: ThemeColors }) {
  switch (status) {
    case "running":
      return <PulseDot color={colors.ok} size={8} />;
    case "failed":
      return <View style={[dotStyles.dot, { backgroundColor: colors.error }]} />;
    case "stopped":
      return <View style={[dotStyles.dot, { borderWidth: 1.5, borderColor: colors.faint }]} />;
    default:
      return <View style={[dotStyles.dot, { backgroundColor: colors.faint }]} />;
  }
}

/** Live from its start while it runs; the CLI's own figure once it reports; nothing when neither is known. */
function durationOf(node: AgentNode, now: number): string | null {
  if (node.status === "running" && node.startedAtMs !== null) return formatTurnDuration(now - node.startedAtMs);
  if (node.usage) return formatTurnDuration(node.usage.durationMs);
  return null;
}

const dotStyles = StyleSheet.create({
  dot: { width: 8, height: 8, borderRadius: 4 },
});

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex1: { flex: 1, minWidth: 0 },
    headerBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: colors.hover,
      borderRadius: radius.pill,
      paddingHorizontal: 9,
      paddingVertical: 6,
    },
    headerBtnCount: { color: colors.dim, fontSize: 12, fontWeight: "700", fontVariant: ["tabular-nums"] },
    subtitle: { color: colors.faint, fontSize: 12, textAlign: "center", marginTop: -8, marginBottom: 8 },
    list: { paddingHorizontal: 12, paddingBottom: 8 },
    empty: { color: colors.faint, fontSize: 13, textAlign: "center", paddingVertical: 24 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 10,
      paddingVertical: 9,
      borderRadius: radius.sm,
    },
    dotSlot: { width: 10, alignItems: "center" },
    labelLine: { flexDirection: "row", alignItems: "center", gap: 6 },
    label: { color: colors.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
    tag: { backgroundColor: withAlpha(colors.text, 0.08), borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
    tagText: { color: colors.dim, fontSize: 10, fontWeight: "600" },
    meta: { color: colors.faint, fontSize: 12, marginTop: 2, fontVariant: ["tabular-nums"] },
    detail: { marginLeft: 30, marginRight: 10, marginTop: 2, marginBottom: 8, gap: 6 },
    detailMeta: { color: colors.dim, fontSize: 12 },
    summary: {
      maxHeight: 260,
      backgroundColor: colors.inset,
      borderRadius: radius.xs,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    children: {
      marginLeft: 15,
      paddingLeft: 6,
      borderLeftWidth: 1,
      borderLeftColor: withAlpha(colors.text, 0.14),
    },
  });
