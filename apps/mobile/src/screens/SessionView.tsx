import type { BlockView, PermissionView, TimelineItem, TurnView } from "@crc/client-core";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Markdown } from "../components/Markdown";
import { useClient, useStoreValue } from "../lib/client";
import { statusColorFor, type ThemeColors, useTheme } from "../theme";

export function SessionView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const colors = useTheme();
  const statusColor = statusColorFor(colors);
  const styles = makeStyles(colors);
  const { realtime, config } = useClient();
  const store = realtime.conversation(sessionId);
  const conv = useStoreValue(store);
  const scrollRef = useRef<ScrollView>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    realtime.watch(sessionId);
    return () => realtime.unwatch(sessionId);
  }, [realtime, sessionId]);

  const isController = conv.controller === config.deviceId;
  const status = conv.status ?? "idle";
  const canSend = isController && status !== "busy";

  function send() {
    const t = text.trim();
    if (!t || !canSend) return;
    realtime.submitPrompt(sessionId, t);
    setText("");
  }

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backRow} onPress={onBack}>
          <Ionicons name="chevron-back" size={18} color={colors.accent} />
          <Text style={styles.back}>Back</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {conv.repoName ?? "…"}:{conv.branch ?? ""}
          </Text>
          <Text style={styles.headerSub}>
            <View style={[styles.dot, { backgroundColor: statusColor[status] ?? colors.faint }]} /> {status}
            {conv.controller ? (isController ? " · you're in control" : ` · ${conv.controllerName ?? "other"}`) : " · unlocked"}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.ctrlBtn}
          onPress={() => (isController ? realtime.releaseControl(sessionId) : realtime.takeControl(sessionId))}
        >
          <Text style={styles.ctrlBtnText}>{isController ? "Release" : "Take"}</Text>
        </TouchableOpacity>
      </View>

      {/* Timeline */}
      <ScrollView
        ref={scrollRef}
        style={styles.timeline}
        contentContainerStyle={styles.timelineContent}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {conv.timeline.length === 0 && <Text style={styles.empty}>No messages yet.</Text>}
        {conv.timeline.map((item, i) => (
          <TimelineRow key={i} item={item} colors={colors} styles={styles} />
        ))}
      </ScrollView>

      {/* Pending permissions */}
      {conv.pending.map((p) => (
        <PermissionCard
          key={p.requestId}
          perm={p}
          canAct={isController}
          onDecide={(d) => realtime.resolvePermission(sessionId, p.requestId, d)}
          colors={colors}
          styles={styles}
        />
      ))}

      {/* Composer */}
      <View style={styles.composer}>
        <TextInput
          style={styles.composerInput}
          value={text}
          onChangeText={setText}
          multiline
          editable={canSend}
          placeholder={
            !isController ? "Take control to send prompts" : status === "busy" ? "Claude is working…" : "Send a prompt…"
          }
          placeholderTextColor={colors.faint}
        />
        <TouchableOpacity style={[styles.sendBtn, (!canSend || !text.trim()) && styles.disabled]} disabled={!canSend || !text.trim()} onPress={send}>
          <Text style={styles.sendBtnText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function TimelineRow({ item, colors, styles }: { item: TimelineItem; colors: ThemeColors; styles: Styles }) {
  if (item.type === "prompt") {
    return (
      <View style={styles.promptWrap}>
        <Ionicons name="person-outline" size={14} color={colors.accent} style={styles.promptIcon} />
        <Text style={styles.promptText}>{item.text}</Text>
      </View>
    );
  }
  if (item.type === "notice") {
    return (
      <View style={styles.noticeWrap}>
        <Text style={[styles.notice, item.level === "warn" && styles.noticeWarn]}>{item.text}</Text>
      </View>
    );
  }
  return <AssistantTurn turn={item.turn} colors={colors} styles={styles} />;
}

function AssistantTurn({ turn, colors, styles }: { turn: TurnView; colors: ThemeColors; styles: Styles }) {
  return (
    <View style={styles.turn}>
      {turn.blocks.map((b, i) => (
        <Block key={i} block={b} colors={colors} styles={styles} />
      ))}
      {turn.status === "running" && <Text style={styles.running}>▍</Text>}
      {turn.status === "done" && turn.costUsd != null && (
        <Text style={styles.meta}>
          ${turn.costUsd.toFixed(4)} · {turn.durationMs}ms
        </Text>
      )}
      {turn.status === "error" && <Text style={styles.errText}>Turn failed: {turn.errorMessage}</Text>}
    </View>
  );
}

/** Maps a tool name to a representative Ionicons glyph. */
function toolIcon(name: string): keyof typeof Ionicons.glyphMap {
  const map: Partial<Record<string, keyof typeof Ionicons.glyphMap>> = {
    Bash: "terminal-outline",
    BashOutput: "terminal-outline",
    Read: "document-text-outline",
    Write: "document-outline",
    Edit: "create-outline",
    MultiEdit: "create-outline",
    Grep: "search-outline",
    Glob: "search-outline",
    WebFetch: "globe-outline",
    WebSearch: "search-outline",
    Task: "rocket-outline",
    TodoWrite: "checkbox-outline",
  };
  return map[name] ?? "construct-outline";
}

function Block({ block, colors, styles }: { block: BlockView; colors: ThemeColors; styles: Styles }) {
  if (block.kind === "tool_use") {
    return (
      <View style={styles.toolCard}>
        <View style={styles.toolHeader}>
          <Ionicons name={toolIcon(block.toolName)} size={13} color={colors.busy} />
          <Text style={styles.toolName}>{block.toolName}</Text>
        </View>
        <Text style={styles.toolBody}>{truncate(JSON.stringify(block.toolInput), 300)}</Text>
        {block.result && (
          <Text style={[styles.toolBody, !block.result.ok && styles.errText]}>
            {block.result.ok ? "" : "error: "}
            {truncate(block.result.summary, 300)}
          </Text>
        )}
      </View>
    );
  }
  if (block.kind === "thinking") {
    return <Markdown content={block.text} muted />;
  }
  return <Markdown content={block.text} />;
}

function PermissionCard({
  perm,
  canAct,
  onDecide,
  colors,
  styles,
}: {
  perm: PermissionView;
  canAct: boolean;
  onDecide: (d: "allow" | "deny") => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  return (
    <View style={styles.permCard}>
      <View style={styles.permHeader}>
        <Ionicons name="shield-checkmark-outline" size={14} color={colors.busy} />
        <Text style={styles.permTitle}>Permission: {perm.toolName}</Text>
      </View>
      <Text style={styles.permBody} numberOfLines={4}>
        {truncate(JSON.stringify(perm.toolInput), 240)}
      </Text>
      {canAct ? (
        <View style={styles.permActions}>
          <TouchableOpacity style={styles.allowBtn} onPress={() => onDecide("allow")}>
            <Text style={styles.allowText}>Allow</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.denyBtn} onPress={() => onDecide("deny")}>
            <Text style={styles.denyText}>Deny</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <Text style={styles.permBody}>Only the controller can respond.</Text>
      )}
    </View>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.bg, paddingTop: 44 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    backRow: { flexDirection: "row", alignItems: "center", gap: 2 },
    back: { color: colors.accent, fontSize: 15 },
    headerCenter: { flex: 1 },
    headerTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
    headerSub: { color: colors.faint, fontSize: 11, marginTop: 2 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    ctrlBtn: { backgroundColor: colors.panel2, borderRadius: 2, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.border },
    ctrlBtnText: { color: colors.text, fontSize: 13, fontWeight: "600" },
    timeline: { flex: 1 },
    timelineContent: { padding: 12, gap: 12 },
    empty: { color: colors.faint, fontSize: 14 },
    noticeWrap: { alignItems: "center" },
    notice: {
      backgroundColor: colors.panel2,
      color: colors.dim,
      fontSize: 11,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 12,
      overflow: "hidden",
    },
    noticeWarn: { color: colors.busy },
    promptWrap: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 6,
      backgroundColor: colors.panel,
      borderLeftWidth: 2,
      borderLeftColor: colors.accent,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    promptIcon: { marginTop: 2 },
    promptText: { flex: 1, color: colors.text, fontSize: 15 },
    turn: { gap: 8 },
    running: { color: colors.dim, fontSize: 16 },
    meta: { color: colors.faint, fontSize: 11 },
    errText: { color: colors.danger },
    toolCard: { backgroundColor: colors.panel, borderRadius: 2, borderWidth: 1, borderColor: colors.border, padding: 10, gap: 4 },
    toolHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
    toolName: { color: colors.busy, fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
    toolBody: { color: colors.dim, fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
    permCard: { backgroundColor: colors.panel2, borderTopWidth: 1, borderTopColor: colors.busy, padding: 12, gap: 6 },
    permHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
    permTitle: { color: colors.busy, fontSize: 14, fontWeight: "600" },
    permBody: { color: colors.dim, fontSize: 12 },
    permActions: { flexDirection: "row", gap: 10, marginTop: 4 },
    allowBtn: { backgroundColor: colors.accent, borderRadius: 2, paddingHorizontal: 18, paddingVertical: 8 },
    allowText: { color: colors.accentFg, fontWeight: "600" },
    denyBtn: { borderColor: colors.danger, borderWidth: 1, borderRadius: 2, paddingHorizontal: 18, paddingVertical: 8 },
    denyText: { color: colors.danger, fontWeight: "600" },
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      padding: 10,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    composerInput: {
      flex: 1,
      backgroundColor: colors.panel,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 2,
      paddingHorizontal: 12,
      paddingVertical: 9,
      color: colors.text,
      fontSize: 15,
      maxHeight: 120,
    },
    sendBtn: { backgroundColor: colors.accent, borderRadius: 2, paddingHorizontal: 16, paddingVertical: 11 },
    sendBtnText: { color: colors.accentFg, fontWeight: "600" },
    disabled: { opacity: 0.4 },
  });
