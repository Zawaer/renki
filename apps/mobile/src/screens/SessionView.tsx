import {
  DEFAULT_EFFORT_KEY,
  DEFAULT_PERMISSION_MODE,
  EFFORT_LEVELS,
  estimateTokens,
  formatTokenCount,
  MAX_ATTACHMENTS_PER_PROMPT,
  parseEditView,
  parsePlan,
  parseTodos,
  PERMISSION_MODES,
  THINKING_VERBS,
  type Attachment,
  type BlockView,
  type EditToolView,
  type PermissionModeKey,
  type PermissionView,
  type TimelineItem,
  type TodoItemView,
  type TurnView,
} from "@crc/client-core";
import type { CapabilitiesResponse } from "@crc/protocol";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Markdown } from "../components/Markdown";
import { pickDocumentAttachments, pickImageAttachments, type PendingAttachment } from "../lib/attachments";
import { useClient, useStoreValue } from "../lib/client";
import { statusColorFor, type ThemeColors, useTheme, withAlpha } from "../theme";

export function SessionView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const colors = useTheme();
  const statusColor = statusColorFor(colors);
  const styles = makeStyles(colors);
  const { realtime, rest, config } = useClient();
  const store = realtime.conversation(sessionId);
  const conv = useStoreValue(store);
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const [text, setText] = useState("");
  const [model, setModel] = useState(""); // "" until capabilities load and pick the SDK's own default
  const [effortKey, setEffortKey] = useState(DEFAULT_EFFORT_KEY);
  const [permissionMode, setPermissionMode] = useState<PermissionModeKey>(DEFAULT_PERMISSION_MODE);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse>({ models: [], commands: [] });
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);

  useEffect(() => {
    realtime.watch(sessionId);
    return () => realtime.unwatch(sessionId);
  }, [realtime, sessionId]);

  useEffect(() => {
    rest.getCapabilities().then(setCapabilities).catch(() => {});
  }, [rest]);

  // supportedModels() already includes its own "Default (recommended)" entry
  // (first in the list) — no separate placeholder needed on top of it.
  useEffect(() => {
    if (!model && capabilities.models.length > 0) setModel(capabilities.models[0]?.value ?? "");
  }, [capabilities, model]);

  const isController = conv.controller === config.deviceId;
  const status = conv.status ?? "idle";
  const canSend = isController && status !== "busy";

  // Pop the keyboard to the composer as soon as this device gains control
  // (whether by taking it explicitly or via auto-claim on session creation).
  useEffect(() => {
    if (isController) inputRef.current?.focus();
  }, [isController]);
  const effort = EFFORT_LEVELS.find((e) => e.key === effortKey) ?? EFFORT_LEVELS[0];
  const mode = PERMISSION_MODES.find((m) => m.key === permissionMode) ?? PERMISSION_MODES[0];
  const suggestions =
    text.startsWith("/") && text.length > 1 && !text.includes(" ")
      ? capabilities.commands.filter((c) => c.name.toLowerCase().startsWith(text.slice(1).toLowerCase()))
      : [];

  function send() {
    const t = text.trim();
    if ((!t && attachments.length === 0) || !canSend) return;
    realtime.submitPrompt(sessionId, t, {
      model: model || undefined,
      maxThinkingTokens: effort?.maxThinkingTokens ?? undefined,
      permissionMode,
      attachments: attachments.length > 0 ? attachments.map(({ id: _id, ...a }) => a) : undefined,
    });
    setText("");
    setAttachments([]);
    setAttachError(null);
  }

  /** Appends whatever came back from a picker, surfacing the first error (if any) below the composer. */
  function addPicked(results: Array<PendingAttachment | { error: string }>) {
    const accepted = results.filter((r): r is PendingAttachment => !("error" in r));
    const errors = results.filter((r): r is { error: string } => "error" in r).map((r) => r.error);
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
    setAttachError(errors[0] ?? null);
  }

  async function attachPhoto() {
    setAttachMenuOpen(false);
    const room = MAX_ATTACHMENTS_PER_PROMPT - attachments.length;
    if (room <= 0) return setAttachError(`Up to ${MAX_ATTACHMENTS_PER_PROMPT} attachments per message.`);
    addPicked(await pickImageAttachments(room));
  }

  async function attachDocument() {
    setAttachMenuOpen(false);
    const room = MAX_ATTACHMENTS_PER_PROMPT - attachments.length;
    if (room <= 0) return setAttachError(`Up to ${MAX_ATTACHMENTS_PER_PROMPT} attachments per message.`);
    addPicked(await pickDocumentAttachments(room));
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function cycleModel() {
    if (capabilities.models.length === 0) return;
    const values = capabilities.models.map((m) => m.value);
    const next = values[(values.indexOf(model) + 1) % values.length];
    setModel(next ?? "");
  }

  function cycleEffort() {
    const idx = EFFORT_LEVELS.findIndex((e) => e.key === effortKey);
    const next = EFFORT_LEVELS[(idx + 1) % EFFORT_LEVELS.length];
    if (next) setEffortKey(next.key);
  }

  function cyclePermissionMode() {
    const idx = PERMISSION_MODES.findIndex((m) => m.key === permissionMode);
    const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length];
    if (next) setPermissionMode(next.key);
  }

  function pickSuggestion(name: string) {
    setText(`/${name} `);
  }

  const modelLabel = capabilities.models.find((m) => m.value === model)?.displayName ?? "Default";

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
            {conv.repoName ?? "…"}
            {conv.branch ? `:${conv.branch}` : ""}
          </Text>
          <Text style={styles.headerSub}>
            <View style={[styles.dot, { backgroundColor: statusColor[status] ?? colors.faint }]} /> {status}
            {conv.controller ? (isController ? " · you're in control" : ` · ${conv.controllerName ?? "other"}`) : " · unlocked"}
          </Text>
        </View>
        {!isController && (
          <TouchableOpacity style={styles.ctrlBtn} onPress={() => realtime.takeControl(sessionId)}>
            <Text style={styles.ctrlBtnText}>Take</Text>
          </TouchableOpacity>
        )}
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
          <TimelineRow key={i} item={item} colors={colors} styles={styles} onPreview={setPreviewAttachment} />
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

      {/* Queued prompts — kept out of the timeline so a fast follow-up can't
          render ahead of the turn it's replying to; shown here as "up next". */}
      {conv.queuedPrompts.length > 0 && (
        <View style={styles.queueWrap}>
          <Text style={styles.queueLabel}>
            {conv.queuedPrompts.length === 1 ? "1 message queued" : `${conv.queuedPrompts.length} messages queued`}
          </Text>
          {conv.queuedPrompts.map((q) => (
            <Text key={q.promptId} style={styles.queueItem} numberOfLines={1}>
              {q.text}
            </Text>
          ))}
        </View>
      )}

      {/* Composer */}
      {suggestions.length > 0 && (
        <View style={styles.suggestBox}>
          {suggestions.map((c) => (
            <TouchableOpacity key={c.name} style={styles.suggestRow} onPress={() => pickSuggestion(c.name)}>
              <Text style={styles.suggestName}>/{c.name}</Text>
              <Text style={styles.suggestDesc} numberOfLines={1}>
                {c.description}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      <View style={styles.optionsRow}>
        <TouchableOpacity style={styles.optionPill} onPress={cycleModel}>
          <Text style={styles.optionPillText}>Model: {modelLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.optionPill} onPress={cycleEffort}>
          <Text style={styles.optionPillText}>Effort: {effort?.label ?? "Medium"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.optionPill} onPress={cyclePermissionMode}>
          <Text style={styles.optionPillText}>Mode: {mode?.label ?? "Manual"}</Text>
        </TouchableOpacity>
      </View>
      {attachments.length > 0 && (
        <View style={styles.pendingAttachRow}>
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              colors={colors}
              styles={styles}
              onRemove={() => removeAttachment(a.id)}
              onPreview={setPreviewAttachment}
            />
          ))}
        </View>
      )}
      {attachError && <Text style={styles.attachError}>{attachError}</Text>}
      <View style={styles.composer}>
        <TouchableOpacity style={styles.attachBtn} disabled={!canSend} onPress={() => setAttachMenuOpen(true)}>
          <Ionicons name="attach" size={20} color={canSend ? colors.dim : colors.faint} />
        </TouchableOpacity>
        <TextInput
          ref={inputRef}
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
        {isController && status === "busy" ? (
          <TouchableOpacity style={styles.stopBtn} onPress={() => realtime.interrupt(sessionId)}>
            <Text style={styles.stopBtnText}>Stop</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendBtn, (!canSend || (!text.trim() && attachments.length === 0)) && styles.disabled]}
            disabled={!canSend || (!text.trim() && attachments.length === 0)}
            onPress={send}
          >
            <Text style={styles.sendBtnText}>Send</Text>
          </TouchableOpacity>
        )}
      </View>

      <Modal transparent visible={attachMenuOpen} animationType="fade" onRequestClose={() => setAttachMenuOpen(false)}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setAttachMenuOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.sheetCard}>
            <TouchableOpacity style={styles.sheetRow} onPress={attachPhoto}>
              <Ionicons name="image-outline" size={17} color={colors.text} />
              <Text style={styles.sheetRowText}>Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetRow} onPress={attachDocument}>
              <Ionicons name="document-outline" size={17} color={colors.text} />
              <Text style={styles.sheetRowText}>File (PDF or text)</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <ImagePreviewModal attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
    </KeyboardAvoidingView>
  );
}

/** One attached file: a thumbnail for images, a file chip otherwise. `onRemove` omitted renders it read-only (timeline history). */
function AttachmentChip({
  attachment,
  colors,
  styles,
  onRemove,
  onPreview,
}: {
  attachment: Attachment;
  colors: ThemeColors;
  styles: Styles;
  onRemove?: () => void;
  onPreview?: (a: Attachment) => void;
}) {
  const isImage = attachment.mediaType.startsWith("image/");
  return (
    <TouchableOpacity
      style={styles.attachChip}
      activeOpacity={isImage ? 0.7 : 1}
      disabled={!isImage}
      onPress={isImage ? () => onPreview?.(attachment) : undefined}
    >
      {isImage ? (
        <Image source={{ uri: `data:${attachment.mediaType};base64,${attachment.data}` }} style={styles.attachThumb} />
      ) : (
        <Ionicons name="document-outline" size={14} color={colors.faint} />
      )}
      <Text style={styles.attachName} numberOfLines={1}>
        {attachment.name}
      </Text>
      {onRemove && (
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
          <Ionicons name="close" size={14} color={colors.faint} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

/** Full-screen preview of an attached image, dismissed by backdrop or the close button. */
function ImagePreviewModal({ attachment, onClose }: { attachment: Attachment | null; onClose: () => void }) {
  return (
    <Modal transparent visible={attachment != null} animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={previewStyles.backdrop} activeOpacity={1} onPress={onClose}>
        {attachment && (
          <Image
            source={{ uri: `data:${attachment.mediaType};base64,${attachment.data}` }}
            style={previewStyles.image}
            resizeMode="contain"
          />
        )}
        <TouchableOpacity style={previewStyles.close} onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const previewStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", alignItems: "center", justifyContent: "center" },
  image: { width: "100%", height: "80%" },
  close: { position: "absolute", top: 48, right: 20 },
});

function TimelineRow({
  item,
  colors,
  styles,
  onPreview,
}: {
  item: TimelineItem;
  colors: ThemeColors;
  styles: Styles;
  onPreview: (a: Attachment) => void;
}) {
  if (item.type === "prompt") {
    return (
      <View style={styles.promptWrap}>
        <Ionicons name="person-outline" size={14} color={colors.accent} style={styles.promptIcon} />
        <View style={styles.promptBody}>
          {item.text.length > 0 && <Text style={styles.promptText}>{item.text}</Text>}
          {item.attachments && item.attachments.length > 0 && (
            <View style={styles.attachRow}>
              {item.attachments.map((a, i) => (
                <AttachmentChip key={i} attachment={a} colors={colors} styles={styles} onPreview={onPreview} />
              ))}
            </View>
          )}
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
  return <AssistantTurn turn={item.turn} colors={colors} styles={styles} />;
}

function AssistantTurn({ turn, colors, styles }: { turn: TurnView; colors: ThemeColors; styles: Styles }) {
  return (
    <View style={styles.turn}>
      {turn.blocks.map((b, i) => (
        <Block key={i} block={b} colors={colors} styles={styles} turnRunning={turn.status === "running"} />
      ))}
      {turn.status === "running" && <Text style={styles.running}>▍</Text>}
      {turn.status === "done" && turn.costUsd != null && (
        <Text style={styles.meta}>
          ${turn.costUsd.toFixed(4)} · {turn.durationMs}ms
          {(turn.inputTokens != null || turn.outputTokens != null) &&
            ` · ${formatTokenCount((turn.inputTokens ?? 0) + (turn.outputTokens ?? 0))} tokens`}
        </Text>
      )}
      {turn.status === "error" &&
        (turn.interrupted ? (
          <Text style={styles.meta}>Stopped</Text>
        ) : (
          <Text style={styles.errText}>Turn failed: {turn.errorMessage}</Text>
        ))}
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

function Block({
  block,
  colors,
  styles,
  turnRunning,
}: {
  block: BlockView;
  colors: ThemeColors;
  styles: Styles;
  turnRunning: boolean;
}) {
  if (block.kind === "tool_use") {
    const editView = parseEditView(block.toolName, block.toolInput);
    const todos = block.toolName === "TodoWrite" ? parseTodos(block.toolInput) : null;
    const plan = parsePlan(block.toolName, block.toolInput);
    return (
      <View style={styles.toolCard}>
        <View style={styles.toolHeader}>
          <Ionicons name={toolIcon(block.toolName)} size={13} color={colors.busy} />
          <Text style={styles.toolName}>{block.toolName}</Text>
        </View>
        {editView ? (
          <DiffView view={editView} colors={colors} styles={styles} />
        ) : todos ? (
          <TodoChecklist todos={todos} colors={colors} styles={styles} />
        ) : plan ? (
          <Markdown content={plan} />
        ) : (
          <Text style={styles.toolBody}>{truncate(JSON.stringify(block.toolInput), 300)}</Text>
        )}
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
    return <ThinkingBlock block={block} live={turnRunning && block.endedAtMs == null} colors={colors} styles={styles} />;
  }
  return <Markdown content={block.text} />;
}

function ThinkingBlock({
  block,
  live,
  colors,
  styles,
}: {
  block: Extract<BlockView, { kind: "text" | "thinking" }>;
  live: boolean;
  colors: ThemeColors;
  styles: Styles;
}) {
  const elapsedSeconds = useElapsedSeconds(live ? block.startedAtMs : null);
  const verb = useThinkingVerb(live);
  const estimatedTokens = estimateTokens(block.text);

  return (
    <View style={styles.thinkingWrap}>
      <Text style={styles.thinkingHeader}>
        {live
          ? `${verb}…${elapsedSeconds != null ? ` · ${elapsedSeconds}s` : ""}${
              estimatedTokens > 0 ? ` · ~${formatTokenCount(estimatedTokens)} tokens` : ""
            }`
          : block.startedAtMs != null && block.endedAtMs != null
            ? `Thought for ${formatDuration(block.endedAtMs - block.startedAtMs)}`
            : "Thinking"}
      </Text>
      <Markdown content={block.text} muted />
    </View>
  );
}

/** Ticks once a second while `startedAtMs` is set; null (no ticking) otherwise. */
function useElapsedSeconds(startedAtMs: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAtMs]);
  return startedAtMs == null ? null : Math.max(0, Math.round((now - startedAtMs) / 1000));
}

/** Rotates through THINKING_VERBS while `live`; holds still otherwise. */
function useThinkingVerb(live: boolean): string {
  const [i, setI] = useState(() => Math.floor(Math.random() * THINKING_VERBS.length));
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setI((v) => (v + 1) % THINKING_VERBS.length), 2000);
    return () => clearInterval(id);
  }, [live]);
  return THINKING_VERBS[i] ?? "Thinking";
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
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
  const plan = parsePlan(perm.toolName, perm.toolInput);
  const editView = plan == null ? parseEditView(perm.toolName, perm.toolInput) : null;
  const todos = plan == null && perm.toolName === "TodoWrite" ? parseTodos(perm.toolInput) : null;

  return (
    <View style={styles.permCard}>
      <View style={styles.permHeader}>
        <Ionicons name={plan != null ? "list-outline" : "shield-checkmark-outline"} size={14} color={colors.busy} />
        <Text style={styles.permTitle}>{plan != null ? "Plan ready for review" : `Permission: ${perm.toolName}`}</Text>
      </View>
      {plan != null ? (
        <ScrollView style={styles.permDetailScroll}>
          <Markdown content={plan} muted />
        </ScrollView>
      ) : editView ? (
        <ScrollView style={styles.permDetailScroll}>
          <DiffView view={editView} colors={colors} styles={styles} />
        </ScrollView>
      ) : todos ? (
        <ScrollView style={styles.permDetailScroll}>
          <TodoChecklist todos={todos} colors={colors} styles={styles} />
        </ScrollView>
      ) : (
        <Text style={styles.permBody} numberOfLines={4}>
          {truncate(JSON.stringify(perm.toolInput), 240)}
        </Text>
      )}
      {canAct ? (
        <View style={styles.permActions}>
          <TouchableOpacity style={styles.allowBtn} onPress={() => onDecide("allow")}>
            <Text style={styles.allowText}>{plan != null ? "Approve plan" : "Allow"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.denyBtn} onPress={() => onDecide("deny")}>
            <Text style={styles.denyText}>{plan != null ? "Keep planning" : "Deny"}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <Text style={styles.permBody}>Only the controller can respond.</Text>
      )}
    </View>
  );
}

/** Caps how many diff lines render before collapsing the rest into a note — a full-file Write can be thousands of lines. */
const MAX_DIFF_LINES_SHOWN = 200;

function DiffView({ view, colors, styles }: { view: EditToolView; colors: ThemeColors; styles: Styles }) {
  const totalLines = view.hunks.reduce((n, h) => n + h.lines.length, 0);
  let shown = 0;
  return (
    <View>
      {view.hunks.map((hunk, hi) => {
        if (shown >= MAX_DIFF_LINES_SHOWN) return null;
        const remaining = MAX_DIFF_LINES_SHOWN - shown;
        const lines = hunk.lines.slice(0, remaining);
        shown += lines.length;
        return (
          <View key={hi}>
            {lines.map((line, li) => (
              <Text
                key={li}
                style={[
                  styles.toolBody,
                  line.type === "add"
                    ? { backgroundColor: withAlpha(colors.ok, 0.12), color: colors.ok }
                    : line.type === "del"
                      ? { backgroundColor: withAlpha(colors.danger, 0.12), color: colors.danger }
                      : undefined,
                ]}
              >
                {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
                {line.text}
              </Text>
            ))}
          </View>
        );
      })}
      {totalLines > MAX_DIFF_LINES_SHOWN && (
        <Text style={styles.meta}>… {totalLines - MAX_DIFF_LINES_SHOWN} more lines</Text>
      )}
    </View>
  );
}

function TodoChecklist({ todos, colors, styles }: { todos: TodoItemView[]; colors: ThemeColors; styles: Styles }) {
  return (
    <View>
      {todos.map((t, i) => (
        <View key={i} style={styles.todoRow}>
          <Ionicons
            name={t.status === "completed" ? "checkmark-circle" : t.status === "in_progress" ? "sync-outline" : "ellipse-outline"}
            size={13}
            color={t.status === "completed" ? colors.ok : t.status === "in_progress" ? colors.busy : colors.faint}
          />
          <Text
            style={[
              styles.todoText,
              t.status === "completed" && styles.todoDone,
              t.status === "in_progress" && styles.todoActive,
            ]}
          >
            {t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}
          </Text>
        </View>
      ))}
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
    promptBody: { flex: 1, gap: 6 },
    promptText: { color: colors.text, fontSize: 15 },
    attachRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    pendingAttachRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 10 },
    attachChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.panel2,
      borderRadius: 2,
      paddingVertical: 4,
      paddingHorizontal: 6,
      maxWidth: 160,
    },
    attachThumb: { width: 20, height: 20, borderRadius: 2 },
    attachName: { flex: 1, color: colors.text, fontSize: 11 },
    attachError: { color: colors.danger, fontSize: 12, paddingHorizontal: 10, paddingTop: 4 },
    attachBtn: { paddingVertical: 9, paddingHorizontal: 2 },
    sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
    sheetCard: {
      backgroundColor: colors.panel,
      borderTopLeftRadius: 8,
      borderTopRightRadius: 8,
      paddingVertical: 8,
      paddingBottom: 24,
    },
    sheetRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 14 },
    sheetRowText: { color: colors.text, fontSize: 15 },
    turn: { gap: 8 },
    thinkingWrap: { borderLeftWidth: 2, borderLeftColor: colors.border, paddingLeft: 10, gap: 2 },
    thinkingHeader: { color: colors.faint, fontSize: 11 },
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
    permDetailScroll: { maxHeight: 220, backgroundColor: colors.panel, borderRadius: 2 },
    permActions: { flexDirection: "row", gap: 10, marginTop: 4 },
    todoRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, paddingVertical: 2 },
    todoText: { flex: 1, color: colors.text, fontSize: 12 },
    todoDone: { color: colors.faint, textDecorationLine: "line-through" },
    todoActive: { fontWeight: "600" },
    queueWrap: {
      backgroundColor: colors.panel2,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 2,
    },
    queueLabel: { color: colors.faint, fontSize: 11 },
    queueItem: { color: colors.faint, fontSize: 12 },
    allowBtn: { backgroundColor: colors.accent, borderRadius: 2, paddingHorizontal: 18, paddingVertical: 8 },
    allowText: { color: colors.accentFg, fontWeight: "600" },
    denyBtn: { borderColor: colors.danger, borderWidth: 1, borderRadius: 2, paddingHorizontal: 18, paddingVertical: 8 },
    denyText: { color: colors.danger, fontWeight: "600" },
    optionsRow: {
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 10,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    optionPill: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 2,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    optionPillText: { color: colors.dim, fontSize: 11 },
    suggestBox: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      maxHeight: 160,
    },
    suggestRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.panel,
    },
    suggestName: { color: colors.accent, fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
    suggestDesc: { flex: 1, color: colors.dim, fontSize: 12 },
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      padding: 10,
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
    stopBtn: { borderColor: colors.danger, borderWidth: 1, borderRadius: 2, paddingHorizontal: 16, paddingVertical: 11 },
    stopBtnText: { color: colors.danger, fontWeight: "600" },
    disabled: { opacity: 0.4 },
  });
