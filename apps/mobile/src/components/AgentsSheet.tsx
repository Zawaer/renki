import { Ionicons } from "@expo/vector-icons";
import { type AgentNode, type BackgroundTaskView, flattenAgents, formatTokenCount, formatTurnDuration } from "@renki/client-core";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { radius, type ThemeColors, useTheme, withAlpha } from "../theme";
import { Markdown } from "./Markdown";
import { animateLayout, PulseDot } from "./Motion";
import { Sheet } from "./Sheet";

/**
 * The phone's agent map: every subagent the session started, as a tree, with
 * what each was asked, how it ended, how long it took and what it cost.
 * Opened from the chat's ⋯ menu or the running bar above the composer; it
 * lists the agents and expands one to its answer, with a way to its call in
 * the transcript.
 */

export function AgentsSheet({
  visible,
  onClose,
  agents,
  commands,
  onShowInTranscript,
}: {
  visible: boolean;
  onClose: () => void;
  agents: AgentNode[];
  /** Commands sent to run in the background, listed under the agents as on the web's agent map. */
  commands: BackgroundTaskView[];
  /** Closes the sheet and scrolls the chat to this call, opened and flashed. */
  onShowInTranscript?: (toolUseId: string) => void;
}) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const all = useMemo(() => flattenAgents(agents), [agents]);
  const running = all.filter((a) => a.status === "running").length;
  const commandsRunning = commands.filter((c) => c.status === "running").length;
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

  const subtitle = [
    `${all.length} ${all.length === 1 ? "agent" : "agents"}`,
    `${commands.length} background ${commands.length === 1 ? "command" : "commands"}`,
    running + commandsRunning > 0 ? `${running + commandsRunning} running` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Sheet visible={visible} onClose={onClose} title="Agents & background" colors={colors}>
      <Text style={styles.subtitle}>{subtitle}</Text>
      <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
        {agents.length === 0 && commands.length === 0 && <Text style={styles.empty}>Nothing has run in the background in this chat.</Text>}
        {agents.map((a) => (
          <AgentTree key={a.toolUseId} node={a} now={now} expanded={expanded} onToggle={toggle} onShow={onShowInTranscript} colors={colors} styles={styles} />
        ))}
        {commands.length > 0 && <Text style={styles.section}>Background commands</Text>}
        {commands.map((c) => (
          <CommandRow
            key={c.toolUseId}
            task={c}
            open={expanded.has(c.toolUseId)}
            onToggle={() => toggle(c.toolUseId)}
            onShow={onShowInTranscript && (() => onShowInTranscript(c.toolUseId))}
            colors={colors}
            styles={styles}
          />
        ))}
      </ScrollView>
    </Sheet>
  );
}

function AgentTree({
  node,
  now,
  expanded,
  onToggle,
  onShow,
  colors,
  styles,
}: {
  node: AgentNode;
  now: number;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onShow?: (toolUseId: string) => void;
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
          {onShow && <ShowButton onPress={() => onShow(node.toolUseId)} colors={colors} styles={styles} />}
        </View>
      )}
      {node.children.length > 0 && (
        <View style={styles.children}>
          {node.children.map((c) => (
            <AgentTree key={c.toolUseId} node={c} now={now} expanded={expanded} onToggle={onToggle} onShow={onShow} colors={colors} styles={styles} />
          ))}
        </View>
      )}
    </View>
  );
}

/** One backgrounded command: what ran, how it ended, and its output summary when opened. */
function CommandRow({
  task,
  open,
  onToggle,
  onShow,
  colors,
  styles,
}: {
  task: BackgroundTaskView;
  open: boolean;
  onToggle: () => void;
  onShow?: () => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  return (
    <View>
      <TouchableOpacity
        style={[styles.row, open && { backgroundColor: colors.hover }]}
        onPress={onToggle}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <View style={styles.dotSlot}>
          <StatusDot status={task.status === "completed" ? "done" : task.status} colors={colors} />
        </View>
        <View style={styles.flex1}>
          <Text style={[styles.label, task.status === "stopped" && { color: colors.dim }]} numberOfLines={open ? undefined : 1}>
            {task.label}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {task.status === "running" ? "no result yet" : task.status}
          </Text>
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={14} color={colors.faint} />
      </TouchableOpacity>
      {open && (
        <View style={styles.detail}>
          {task.summary ? (
            <ScrollView style={styles.summary} nestedScrollEnabled>
              <Text style={styles.detailMeta}>{task.summary}</Text>
            </ScrollView>
          ) : (
            <Text style={styles.detailMeta}>{task.status === "running" ? "No result yet." : "No output recorded."}</Text>
          )}
          {onShow && <ShowButton onPress={onShow} colors={colors} styles={styles} />}
        </View>
      )}
    </View>
  );
}

function ShowButton({ onPress, colors, styles }: { onPress: () => void; colors: ThemeColors; styles: Styles }) {
  return (
    <TouchableOpacity style={styles.showBtn} onPress={onPress} activeOpacity={0.7} accessibilityRole="button">
      <Ionicons name="locate-outline" size={14} color={colors.text} />
      <Text style={styles.showText}>Show in transcript</Text>
    </TouchableOpacity>
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
    subtitle: { color: colors.faint, fontSize: 12, textAlign: "center", marginTop: -8, marginBottom: 8 },
    section: { color: colors.dim, fontSize: 12, fontWeight: "600", marginTop: 14, marginBottom: 4, marginLeft: 4 },
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
    showBtn: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: withAlpha(colors.text, 0.08),
      borderRadius: radius.pill,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    showText: { color: colors.text, fontSize: 12.5, fontWeight: "600" },
    children: {
      marginLeft: 15,
      paddingLeft: 6,
      borderLeftWidth: 1,
      borderLeftColor: withAlpha(colors.text, 0.14),
    },
  });
