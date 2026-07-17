import type { BlockView, PermissionView, TimelineItem, TurnView } from "@crc/client-core";
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
import { useClient, useStoreValue } from "../lib/client";
import { colors, statusColor } from "../theme";

export function SessionView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
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
        <TouchableOpacity onPress={onBack}>
          <Text style={styles.back}>‹ Back</Text>
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
          <TimelineRow key={i} item={item} />
        ))}
      </ScrollView>

      {/* Pending permissions */}
      {conv.pending.map((p) => (
        <PermissionCard
          key={p.requestId}
          perm={p}
          canAct={isController}
          onDecide={(d) => realtime.resolvePermission(sessionId, p.requestId, d)}
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

function TimelineRow({ item }: { item: TimelineItem }) {
  if (item.type === "prompt") {
    return (
      <View style={styles.userBubbleWrap}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{item.text}</Text>
        </View>
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
  return <AssistantTurn turn={item.turn} />;
}

function AssistantTurn({ turn }: { turn: TurnView }) {
  return (
    <View style={styles.turn}>
      {turn.blocks.map((b, i) => (
        <Block key={i} block={b} />
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

function Block({ block }: { block: BlockView }) {
  if (block.kind === "tool_use") {
    return (
      <View style={styles.toolCard}>
        <Text style={styles.toolName}>⚙ {block.toolName}</Text>
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
    return <Text style={styles.thinking}>{block.text}</Text>;
  }
  return <Text style={styles.assistantText}>{block.text}</Text>;
}

function PermissionCard({
  perm,
  canAct,
  onDecide,
}: {
  perm: PermissionView;
  canAct: boolean;
  onDecide: (d: "allow" | "deny") => void;
}) {
  return (
    <View style={styles.permCard}>
      <Text style={styles.permTitle}>Permission: {perm.toolName}</Text>
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

const styles = StyleSheet.create({
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
  back: { color: colors.accent, fontSize: 15 },
  headerCenter: { flex: 1 },
  headerTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  headerSub: { color: colors.faint, fontSize: 11, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  ctrlBtn: { backgroundColor: colors.panel2, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: colors.border },
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
  userBubbleWrap: { alignItems: "flex-end" },
  userBubble: { backgroundColor: colors.accent, borderRadius: 16, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 9, maxWidth: "85%" },
  userText: { color: "#fff", fontSize: 15 },
  turn: { gap: 8 },
  assistantText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  thinking: { color: colors.faint, fontSize: 14, fontStyle: "italic" },
  running: { color: colors.dim, fontSize: 16 },
  meta: { color: colors.faint, fontSize: 11 },
  errText: { color: colors.danger },
  toolCard: { backgroundColor: colors.panel, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 10, gap: 4 },
  toolName: { color: colors.busy, fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  toolBody: { color: colors.dim, fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  permCard: { backgroundColor: colors.panel2, borderTopWidth: 1, borderTopColor: colors.busy, padding: 12, gap: 6 },
  permTitle: { color: colors.busy, fontSize: 14, fontWeight: "600" },
  permBody: { color: colors.dim, fontSize: 12 },
  permActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  allowBtn: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 18, paddingVertical: 8 },
  allowText: { color: "#fff", fontWeight: "600" },
  denyBtn: { borderColor: colors.danger, borderWidth: 1, borderRadius: 8, paddingHorizontal: 18, paddingVertical: 8 },
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
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: colors.text,
    fontSize: 15,
    maxHeight: 120,
  },
  sendBtn: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 11 },
  sendBtnText: { color: "#fff", fontWeight: "600" },
  disabled: { opacity: 0.4 },
});
