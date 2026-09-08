import {
  DEFAULT_EFFORT_KEY,
  DEFAULT_PERMISSION_MODE,
  EFFORT_LEVELS,
  estimateTokens,
  formatCost,
  formatTokenCount,
  formatTurnDuration,
  MAX_ATTACHMENTS_PER_PROMPT,
  parseAskUserQuestion,
  describeTool,
  parseEditView,
  parsePlan,
  parseTodos,
  PERMISSION_MODES,
  THINKING_VERBS,
  turnTriggerLabel,
  type AskUserQuestionView,
  type Attachment,
  type BlockView,
  type EditToolView,
  type PermissionModeKey,
  type PermissionView,
  type SteeredPromptView,
  type SubagentView,
  type TimelineItem,
  type TodoItemView,
  type TurnView,
} from "@crc/client-core";
import type { CapabilitiesResponse } from "@crc/protocol";
import { Ionicons } from "@expo/vector-icons";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Markdown } from "../components/Markdown";
import { Sheet } from "../components/Sheet";
import { pickDocumentAttachments, pickImageAttachments, type PendingAttachment } from "../lib/attachments";
import { loadEffortKey, loadModel, loadPermissionMode, saveEffortKey, saveModel, savePermissionMode } from "../lib/composerPrefs";
import { useClient, useStoreValue } from "../lib/client";
import { useAndroidKeyboardResizeAnimation } from "../lib/useAndroidKeyboardResizeAnimation";
import { radius, softShadow, statusColorFor, type ThemeColors, useTheme, withAlpha } from "../theme";

export function SessionView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const colors = useTheme();
  const statusColor = statusColorFor(colors);
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const { realtime, rest, config } = useClient();
  const store = realtime.conversation(sessionId);
  const conv = useStoreValue(store);
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const [text, setText] = useState("");
  // All three persisted on-device (see lib/composerPrefs.ts) so they don't
  // silently reset to their defaults every app restart.
  const [model, setModelState] = useState("");
  const [effortKey, setEffortKeyState] = useState(DEFAULT_EFFORT_KEY);
  const [permissionMode, setPermissionModeState] = useState<PermissionModeKey>(DEFAULT_PERMISSION_MODE);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse>({ models: [], commands: [] });
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [effortSheetOpen, setEffortSheetOpen] = useState(false);
  const [modeSheetOpen, setModeSheetOpen] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);

  useEffect(() => {
    realtime.watch(sessionId);
    return () => realtime.unwatch(sessionId);
  }, [realtime, sessionId]);

  useAndroidKeyboardResizeAnimation();

  // Capabilities and the persisted prefs are fetched together so the
  // "default model from capabilities" logic below only ever runs once both
  // are known — otherwise a slow SecureStore read racing a fast capabilities
  // fetch could let the default stomp a persisted pick.
  useEffect(() => {
    Promise.all([
      loadModel(),
      loadEffortKey(),
      loadPermissionMode(),
      rest.getCapabilities().catch((): CapabilitiesResponse => ({ models: [], commands: [] })),
    ]).then(([m, e, p, caps]) => {
      setCapabilities(caps);
      setEffortKeyState(e);
      setPermissionModeState(p);
      setModelState(m || caps.models[0]?.value || "");
    });
  }, [rest]);

  function setModel(next: string) {
    setModelState(next);
    saveModel(next);
  }

  function setEffortKey(next: string) {
    setEffortKeyState(next);
    saveEffortKey(next);
  }

  function setPermissionMode(next: PermissionModeKey) {
    setPermissionModeState(next);
    savePermissionMode(next);
  }

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

  function pickSuggestion(name: string) {
    setText(`/${name} `);
  }

  const modelLabel = capabilities.models.find((m) => m.value === model)?.displayName ?? "Default";

  return (
    <KeyboardAvoidingView
      style={[styles.fill, { paddingTop: insets.top + 10 }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backRow} onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
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
            <Text style={styles.ctrlBtnText}>Take control</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Timeline */}
      {/*
        keyboardShouldPersistTaps below (here and on the two other ScrollViews
        in this screen): a RN ScrollView's default ("never") eats the FIRST
        tap on any child to just dismiss the keyboard whenever a TextInput
        elsewhere has focus, requiring a second tap to actually register —
        e.g. tapping an option pill while the composer is focused would only
        close the keyboard, not open that pill's sheet. "handled" here (and
        below on pickerList) only forwards a tap to a child that itself
        handles it, which is enough since nothing here needs to work while a
        tap is also trying to scroll. optionsRow uses the stronger "always"
        instead, since it's the exact row this bug was originally reported
        against — "handled" would likely have been enough there too, but
        "always" is the safer choice for the one ScrollView the fix has to
        actually work on.
      */}
      <ScrollView
        ref={scrollRef}
        style={styles.timeline}
        contentContainerStyle={styles.timelineContent}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        keyboardShouldPersistTaps="handled"
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
          onDecide={(d, updatedInput) => realtime.resolvePermission(sessionId, p.requestId, d, updatedInput)}
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
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.optionsRow}
        contentContainerStyle={styles.optionsRowContent}
        keyboardShouldPersistTaps="always"
      >
        <TouchableOpacity style={styles.optionPill} onPress={() => setModelSheetOpen(true)}>
          <Text style={styles.optionPillText} numberOfLines={1}>
            {modelLabel}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.optionPill} onPress={() => setEffortSheetOpen(true)}>
          <Text style={styles.optionPillText}>{effort?.label ?? "Medium"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.optionPill} onPress={() => setModeSheetOpen(true)}>
          <Text style={styles.optionPillText}>{mode?.label ?? "Manual"}</Text>
        </TouchableOpacity>
      </ScrollView>
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
      <View style={styles.composerWrap}>
        <View style={styles.composerPill}>
          <TouchableOpacity style={styles.roundIconBtn} disabled={!isController} onPress={() => setAttachMenuOpen(true)}>
            <Ionicons name="add" size={22} color={isController ? colors.text : colors.faint} />
          </TouchableOpacity>
          <TextInput
            ref={inputRef}
            style={styles.composerInput}
            value={text}
            onChangeText={setText}
            multiline
            placeholder={
              !isController ? "Take control to send prompts" : status === "busy" ? "Claude is working…" : "Chat with Claude…"
            }
            placeholderTextColor={colors.faint}
          />
          {isController && status === "busy" ? (
            <TouchableOpacity style={styles.stopBtn} onPress={() => realtime.interrupt(sessionId)}>
              <Ionicons name="stop" size={15} color={colors.accentFg} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.sendBtn, (!canSend || (!text.trim() && attachments.length === 0)) && styles.disabled]}
              disabled={!canSend || (!text.trim() && attachments.length === 0)}
              onPress={send}
            >
              <Ionicons name="arrow-up" size={19} color={colors.accentFg} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Attach sheet */}
      <Sheet visible={attachMenuOpen} onClose={() => setAttachMenuOpen(false)} title="Add to chat" colors={colors}>
        <View style={styles.attachTileRow}>
          <TouchableOpacity style={styles.attachTile} onPress={attachPhoto}>
            <View style={styles.attachTileIcon}>
              <Ionicons name="image-outline" size={24} color={colors.text} />
            </View>
            <Text style={styles.attachTileLabel}>Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.attachTile} onPress={attachDocument}>
            <View style={styles.attachTileIcon}>
              <Ionicons name="document-outline" size={24} color={colors.text} />
            </View>
            <Text style={styles.attachTileLabel}>File</Text>
          </TouchableOpacity>
        </View>
      </Sheet>

      <PickerSheet
        visible={modelSheetOpen}
        onClose={() => setModelSheetOpen(false)}
        title="Select model"
        options={capabilities.models.map((m) => ({ key: m.value, label: m.displayName, description: m.description }))}
        selectedKey={model}
        onSelect={setModel}
        colors={colors}
        styles={styles}
      />
      <PickerSheet
        visible={effortSheetOpen}
        onClose={() => setEffortSheetOpen(false)}
        title="Thinking effort"
        options={EFFORT_LEVELS.map((e) => ({ key: e.key, label: e.label }))}
        selectedKey={effortKey}
        onSelect={setEffortKey}
        colors={colors}
        styles={styles}
      />
      <PickerSheet
        visible={modeSheetOpen}
        onClose={() => setModeSheetOpen(false)}
        title="Permission mode"
        options={PERMISSION_MODES.map((m) => ({ key: m.key, label: m.label, description: m.description }))}
        selectedKey={permissionMode}
        onSelect={(k) => setPermissionMode(k as PermissionModeKey)}
        colors={colors}
        styles={styles}
      />

      <ImagePreviewModal attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
    </KeyboardAvoidingView>
  );
}

/** A bottom sheet listing selectable options with a checkmark on the current pick — model/effort/permission-mode all use this. */
function PickerSheet({
  visible,
  onClose,
  title,
  options,
  selectedKey,
  onSelect,
  colors,
  styles,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: { key: string; label: string; description?: string }[];
  selectedKey: string;
  onSelect: (key: string) => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title} colors={colors}>
      <ScrollView contentContainerStyle={styles.pickerList} keyboardShouldPersistTaps="handled">
        {options.map((o) => {
          const selected = o.key === selectedKey;
          return (
            <TouchableOpacity
              key={o.key}
              style={[styles.pickerRow, selected && { backgroundColor: withAlpha(colors.accent, 0.16) }]}
              onPress={() => {
                onSelect(o.key);
                onClose();
              }}
            >
              <View style={styles.flex1}>
                <Text style={[styles.pickerRowLabel, selected && { color: colors.accent }]}>{o.label}</Text>
                {o.description && <Text style={styles.pickerRowDesc}>{o.description}</Text>}
              </View>
              {selected && <Ionicons name="checkmark" size={19} color={colors.accent} />}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </Sheet>
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
        {item.text.length > 0 && <Text style={styles.promptText}>{item.text}</Text>}
        {item.attachments && item.attachments.length > 0 && (
          <View style={styles.attachRow}>
            {item.attachments.map((a, i) => (
              <AttachmentChip key={i} attachment={a} colors={colors} styles={styles} onPreview={onPreview} />
            ))}
          </View>
        )}
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
  const label = turnTriggerLabel(turn);
  const steeredAfter = (index: number) => turn.steeredPrompts.filter((p) => p.afterBlockIndex === index);
  return (
    <View style={styles.turn}>
      {label && <Text style={styles.meta}>{label}</Text>}
      {steeredAfter(-1).map((p) => (
        <SteeredPrompt key={p.promptId} prompt={p} styles={styles} />
      ))}
      {turn.blocks.map((b, i) => (
        <Fragment key={i}>
          <Block block={b} colors={colors} styles={styles} turnRunning={turn.status === "running"} />
          {steeredAfter(i).map((p) => (
            <SteeredPrompt key={p.promptId} prompt={p} styles={styles} />
          ))}
        </Fragment>
      ))}
      {turn.status === "running" && <Text style={styles.running}>▍</Text>}
      {turn.status === "done" && <TurnFooter turn={turn} colors={colors} styles={styles} />}
      {turn.status === "error" &&
        (turn.interrupted ? (
          <Text style={styles.meta}>Stopped</Text>
        ) : (
          <Text style={styles.errText}>Turn failed: {turn.errorMessage}</Text>
        ))}
    </View>
  );
}

/** A prompt sent while this turn was already running — shown inside the turn, where Claude picked it up. */
function SteeredPrompt({ prompt, styles }: { prompt: SteeredPromptView; styles: Styles }) {
  return (
    <View style={[styles.promptWrap, styles.steeredWrap]}>
      {prompt.text.length > 0 && <Text style={styles.promptText}>{prompt.text}</Text>}
      <Text style={styles.meta}>Sent while Claude was working · picked up mid-turn</Text>
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
    return <ToolStep block={block} colors={colors} styles={styles} turnRunning={turnRunning} />;
  }
  if (block.kind === "thinking") {
    return <ThinkingBlock block={block} live={turnRunning && block.endedAtMs == null} colors={colors} styles={styles} />;
  }
  return <Markdown content={block.text} />;
}

/**
 * A tool call as a quiet disclosure row — "Edited manager.ts ›" with its
 * outcome at the right — rather than a card with the raw JSON input dumped
 * inside it, which is what the phone used to show.
 *
 * Opens itself while the call is running or when the payload is worth seeing
 * unprompted (a diff, a plan, a task list, a live agent) and folds shut once a
 * routine call settles — unless the reader opened it themselves.
 */
function ToolStep({
  block,
  colors,
  styles,
  turnRunning,
}: {
  block: Extract<BlockView, { kind: "tool_use" }>;
  colors: ThemeColors;
  styles: Styles;
  turnRunning: boolean;
}) {
  const editView = parseEditView(block.toolName, block.toolInput);
  const todos = block.toolName === "TodoWrite" ? parseTodos(block.toolInput) : null;
  const plan = parsePlan(block.toolName, block.toolInput);
  const { label, meta } = describeTool(block.toolName, block.toolInput);
  // A background agent's nested feed never gets a closing tool_result (its
  // Task call returned immediately), so its completion notice is the real
  // "done" signal.
  const agentRunning = block.subagent?.status === "running" && !block.backgroundTask;
  const running = !block.result && !block.backgroundTask && turnRunning;
  const richPayload = editView != null || todos != null || plan != null || block.subagent != null;
  const restingOpen = richPayload && (agentRunning || block.subagent == null);
  const [open, setOpen] = useState(running || restingOpen);
  const userToggled = useRef(false);
  const wasRunning = useRef(running || agentRunning);
  useEffect(() => {
    const nowRunning = running || agentRunning;
    if (wasRunning.current && !nowRunning && !userToggled.current) setOpen(restingOpen);
    wasRunning.current = nowRunning;
  }, [running, agentRunning, restingOpen]);

  // One glyph language for every step: check = finished, cross = failed,
  // spinner-ish dot = still going, square = stopped.
  const outcome: { icon: keyof typeof Ionicons.glyphMap; color: string } | null = block.backgroundTask
    ? block.backgroundTask.status === "completed"
      ? { icon: "checkmark", color: colors.ok }
      : block.backgroundTask.status === "stopped"
        ? { icon: "square", color: colors.faint }
        : { icon: "close", color: colors.danger }
    : block.subagent
      ? agentRunning
        ? { icon: "ellipsis-horizontal", color: colors.faint }
        : { icon: "checkmark", color: colors.ok }
      : block.result
        ? block.result.ok
          ? { icon: "checkmark", color: colors.ok }
          : { icon: "close", color: colors.danger }
        : running
          ? { icon: "ellipsis-horizontal", color: colors.faint }
          : null;

  return (
    <View style={styles.toolStep}>
      <TouchableOpacity
        style={styles.toolStepHeader}
        activeOpacity={0.7}
        onPress={() => {
          userToggled.current = true;
          setOpen((o) => !o);
        }}
      >
        <Ionicons name={toolIcon(block.toolName)} size={13} color={colors.faint} />
        <Text style={styles.toolStepLabel} numberOfLines={1}>
          {label}
        </Text>
        {meta && (
          <Text style={styles.toolStepMeta} numberOfLines={1}>
            {meta}
          </Text>
        )}
        {outcome && <Ionicons name={outcome.icon} size={13} color={outcome.color} />}
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={12} color={colors.faint} />
      </TouchableOpacity>
      {open && (
        <View style={styles.toolStepBody}>
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
          {block.subagent && <SubagentActivity subagent={block.subagent} colors={colors} styles={styles} />}
          {block.backgroundTask && (
            <Text style={styles.toolBody}>{truncate(block.backgroundTask.summary, 300)}</Text>
          )}
        </View>
      )}
    </View>
  );
}

/** A Task call's own nested activity, live-streamed via the Agent SDK's forwardSubagentText — collapsible, open by default while running, auto-collapses once done. Mirrors web's <details>-based SubagentActivity. */
function SubagentActivity({ subagent, colors, styles }: { subagent: SubagentView; colors: ThemeColors; styles: Styles }) {
  const [expanded, setExpanded] = useState(subagent.status === "running");
  const prevStatus = useRef(subagent.status);

  useEffect(() => {
    if (prevStatus.current === "running" && subagent.status === "done") setExpanded(false);
    prevStatus.current = subagent.status;
  }, [subagent.status]);

  return (
    <View style={styles.subagentWrap}>
      <TouchableOpacity style={styles.subagentHeader} onPress={() => setExpanded((v) => !v)}>
        {subagent.status === "running" ? (
          <ActivityIndicator size="small" color={colors.busy} />
        ) : (
          <Ionicons name="checkmark-circle" size={14} color={colors.ok} />
        )}
        <Text style={styles.subagentType}>{subagent.subagentType ?? "Subagent"}</Text>
        {subagent.taskDescription && (
          <Text style={styles.subagentDesc} numberOfLines={1}>
            — {subagent.taskDescription}
          </Text>
        )}
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={14} color={colors.faint} />
      </TouchableOpacity>
      {expanded && (
        <View style={styles.subagentBody}>
          {subagent.blocks.map((b, i) => (
            <Block key={i} block={b} colors={colors} styles={styles} turnRunning={subagent.status === "running"} />
          ))}
        </View>
      )}
    </View>
  );
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
            ? `Thought for ${formatTurnDuration(block.endedAtMs - block.startedAtMs)}`
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

/**
 * How long the turn took, with tokens and cost a tap away.
 *
 * Same call as the web made: they're stats, not something to act on — the cost
 * is a notional API-equivalent figure rather than anything billed — and on a
 * phone a four-item footer under every turn is most of the line. Tap, rather
 * than the web's hover, because a phone has no hover; the detail opens inline
 * underneath instead of as a floating card, which is easier to read and to
 * dismiss with a thumb.
 */
function TurnFooter({ turn, colors, styles }: { turn: TurnView; colors: ThemeColors; styles: Styles }) {
  const [open, setOpen] = useState(false);
  const rows: Array<[string, string]> = [];
  if (turn.inputTokens != null) rows.push(["Input", `${formatTokenCount(turn.inputTokens)} tokens`]);
  if (turn.cachedInputTokens) rows.push(["Cached", `${formatTokenCount(turn.cachedInputTokens)} tokens`]);
  if (turn.outputTokens != null) rows.push(["Output", `${formatTokenCount(turn.outputTokens)} tokens`]);
  if (turn.costUsd != null) rows.push(["API cost", formatCost(turn.costUsd)]);

  return (
    <View>
      <View style={styles.turnFooter}>
        <Text style={styles.meta}>{formatTurnDuration(turn.durationMs ?? 0)}</Text>
        {rows.length > 0 && (
          <TouchableOpacity
            onPress={() => setOpen((v) => !v)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Tokens and cost"
          >
            <Ionicons name={open ? "information-circle" : "information-circle-outline"} size={14} color={colors.faint} />
          </TouchableOpacity>
        )}
        {/* One turn can answer several prompts — anything steered into it
            mid-flight — so this stays visible: it changes what the transcript
            above means, which a token count does not. */}
        {turn.steeredPrompts.length > 0 && (
          <Text style={styles.meta}>· covers {turn.steeredPrompts.length + 1} messages</Text>
        )}
      </View>
      {open && (
        <View style={styles.turnDetails}>
          {rows.map(([label, value]) => (
            <View key={label} style={styles.turnDetailRow}>
              <Text style={styles.turnDetailLabel}>{label}</Text>
              <Text style={styles.turnDetailValue}>{value}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
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
  onDecide: (d: "allow" | "deny", updatedInput?: Record<string, unknown>) => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  const askQuestion = parseAskUserQuestion(perm.toolName, perm.toolInput);
  const plan = askQuestion == null ? parsePlan(perm.toolName, perm.toolInput) : null;
  const editView = plan == null && askQuestion == null ? parseEditView(perm.toolName, perm.toolInput) : null;
  const todos =
    plan == null && askQuestion == null && perm.toolName === "TodoWrite" ? parseTodos(perm.toolInput) : null;

  if (askQuestion != null) {
    return (
      <AskUserQuestionCard
        view={askQuestion}
        canAct={canAct}
        onSubmit={(answers) => onDecide("allow", { ...(perm.toolInput as Record<string, unknown>), answers })}
        onCancel={() => onDecide("deny")}
        colors={colors}
        styles={styles}
      />
    );
  }

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

const OTHER_OPTION = "__other__";

/**
 * AskUserQuestion's own card: tappable option rows instead of raw-JSON
 * Allow/Deny, one tab per question when there's more than one. The model
 * never includes an "Other" choice itself (the tool's contract says the
 * caller provides it), so it's added here for every question.
 */
function AskUserQuestionCard({
  view,
  canAct,
  onSubmit,
  onCancel,
  colors,
  styles,
}: {
  view: AskUserQuestionView;
  canAct: boolean;
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: () => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [selected, setSelected] = useState<string[][]>(() => view.questions.map(() => []));
  const [otherText, setOtherText] = useState<string[]>(() => view.questions.map(() => ""));

  const question = view.questions[activeIndex]!;
  const activeSelected = selected[activeIndex] ?? [];

  function toggleOption(label: string): void {
    setSelected((prev) => {
      const next = prev.slice();
      const current = next[activeIndex] ?? [];
      next[activeIndex] = question.multiSelect
        ? current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
        : current.includes(label)
          ? []
          : [label];
      return next;
    });
  }

  const allAnswered = view.questions.every((_, i) => {
    const sel = selected[i] ?? [];
    if (sel.length === 0) return false;
    return !sel.includes(OTHER_OPTION) || (otherText[i]?.trim().length ?? 0) > 0;
  });

  function handleSubmit(): void {
    const answers: Record<string, string> = {};
    view.questions.forEach((q, i) => {
      const labels = (selected[i] ?? []).map((l) => (l === OTHER_OPTION ? (otherText[i]?.trim() ?? "") : l));
      answers[q.question] = labels.join(", ");
    });
    onSubmit(answers);
  }

  return (
    <View style={styles.permCard}>
      <View style={styles.permHeader}>
        <Ionicons name="help-circle-outline" size={14} color={colors.busy} />
        <Text style={styles.permTitle}>Question</Text>
      </View>
      {view.questions.length > 1 && (
        <View style={styles.askQTabs}>
          {view.questions.map((q, i) => (
            <TouchableOpacity
              key={q.header + i}
              onPress={() => setActiveIndex(i)}
              style={[styles.askQTab, i === activeIndex && styles.askQTabActive]}
            >
              <Text style={[styles.askQTabText, i === activeIndex && styles.askQTabTextActive]}>{q.header}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      <Text style={styles.askQQuestion}>{question.question}</Text>
      {question.options.map((opt) => {
        const isSelected = activeSelected.includes(opt.label);
        return (
          <TouchableOpacity
            key={opt.label}
            disabled={!canAct}
            onPress={() => toggleOption(opt.label)}
            style={[styles.askQOptionRow, isSelected && styles.askQOptionRowSelected]}
          >
            <Text style={styles.askQOptionLabel}>{opt.label}</Text>
            <Text style={styles.askQOptionDesc}>{opt.description}</Text>
          </TouchableOpacity>
        );
      })}
      <TouchableOpacity
        disabled={!canAct}
        onPress={() => toggleOption(OTHER_OPTION)}
        style={[styles.askQOptionRow, activeSelected.includes(OTHER_OPTION) && styles.askQOptionRowSelected]}
      >
        <Text style={styles.askQOptionLabel}>Other</Text>
      </TouchableOpacity>
      {activeSelected.includes(OTHER_OPTION) && (
        <TextInput
          autoFocus
          editable={canAct}
          value={otherText[activeIndex] ?? ""}
          onChangeText={(text) =>
            setOtherText((prev) => {
              const next = prev.slice();
              next[activeIndex] = text;
              return next;
            })
          }
          placeholder="Type your answer…"
          placeholderTextColor={colors.faint}
          style={styles.askQOtherInput}
        />
      )}
      {canAct ? (
        <View style={styles.permActions}>
          <TouchableOpacity
            style={[styles.allowBtn, !allAnswered && { opacity: 0.4 }]}
            disabled={!allAnswered}
            onPress={handleSubmit}
          >
            <Text style={styles.allowText}>Submit answers</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.denyBtn} onPress={onCancel}>
            <Text style={styles.denyText}>Cancel</Text>
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
    fill: { flex: 1, backgroundColor: colors.bg },
    flex1: { flex: 1 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingBottom: 14,
    },
    backRow: { flexDirection: "row", alignItems: "center" },
    headerCenter: { flex: 1 },
    headerTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
    headerSub: { color: colors.faint, fontSize: 11, marginTop: 2 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    ctrlBtn: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
    ctrlBtnText: { color: colors.accentFg, fontSize: 13, fontWeight: "700" },
    timeline: { flex: 1 },
    timelineContent: { padding: 14, gap: 14 },
    empty: { color: colors.faint, fontSize: 14 },
    noticeWrap: { alignItems: "center" },
    notice: {
      backgroundColor: colors.inset,
      color: colors.dim,
      fontSize: 11,
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: radius.pill,
      overflow: "hidden",
    },
    noticeWarn: { color: colors.busy },
    promptWrap: {
      alignSelf: "flex-end",
      maxWidth: "88%",
      backgroundColor: colors.inset,
      borderRadius: radius.lg,
      borderBottomRightRadius: radius.xs,
      paddingHorizontal: 14,
      paddingVertical: 10,
      gap: 6,
    },
    promptText: { color: colors.text, fontSize: 15, lineHeight: 21 },
    steeredWrap: { marginTop: 2 },
    attachRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    pendingAttachRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 16, marginBottom: 4 },
    attachChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.inset,
      borderRadius: radius.pill,
      paddingVertical: 5,
      paddingHorizontal: 10,
      maxWidth: 160,
    },
    attachThumb: { width: 20, height: 20, borderRadius: radius.xs },
    attachName: { flex: 1, color: colors.text, fontSize: 11 },
    attachError: { color: colors.danger, fontSize: 12, paddingHorizontal: 16, paddingTop: 4 },
    pickerList: { paddingHorizontal: 14, gap: 8, paddingBottom: 8 },
    pickerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderRadius: radius.md,
      backgroundColor: colors.inset,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    pickerRowLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
    pickerRowDesc: { color: colors.faint, fontSize: 12, marginTop: 2 },
    attachTileRow: { flexDirection: "row", gap: 20, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 16 },
    attachTile: { alignItems: "center", gap: 8 },
    attachTileIcon: {
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: colors.inset,
      alignItems: "center",
      justifyContent: "center",
    },
    attachTileLabel: { color: colors.text, fontSize: 13 },
    turn: { gap: 10 },
    thinkingWrap: { backgroundColor: withAlpha(colors.faint, 0.1), borderRadius: radius.md, padding: 12, gap: 4 },
    thinkingHeader: { color: colors.faint, fontSize: 11 },
    running: { color: colors.dim, fontSize: 16 },
    meta: { color: colors.faint, fontSize: 11 },
    turnFooter: { flexDirection: "row", alignItems: "center", gap: 6 },
    turnDetails: {
      marginTop: 6,
      alignSelf: "flex-start",
      backgroundColor: colors.inset,
      borderRadius: radius.sm,
      paddingHorizontal: 10,
      paddingVertical: 8,
      gap: 3,
    },
    turnDetailRow: { flexDirection: "row", gap: 14, justifyContent: "space-between" },
    turnDetailLabel: { color: colors.dim, fontSize: 11 },
    turnDetailValue: { color: colors.text, fontSize: 11, fontVariant: ["tabular-nums"] },
    errText: { color: colors.danger },
    toolCard: { backgroundColor: colors.panel, borderRadius: radius.md, padding: 12, gap: 6 },
    toolStep: { marginVertical: 2 },
    toolStepHeader: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 6 },
    toolStepLabel: { color: colors.dim, fontSize: 12.5, flexShrink: 1 },
    toolStepMeta: { color: colors.faint, fontSize: 11.5, fontFamily: undefined, flex: 1 },
    toolStepBody: { gap: 6, paddingBottom: 6, paddingLeft: 20 },
    toolHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
    toolName: { color: colors.busy, fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
    toolBody: { color: colors.dim, fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
    subagentWrap: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 6, paddingTop: 8, gap: 8 },
    subagentHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
    subagentType: { color: colors.text, fontSize: 12, fontWeight: "700" },
    subagentDesc: { flex: 1, color: colors.faint, fontSize: 12 },
    subagentBody: { gap: 8, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: colors.border },
    permCard: { backgroundColor: colors.inset, borderRadius: radius.lg, padding: 14, gap: 8 },
    permHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
    permTitle: { color: colors.busy, fontSize: 14, fontWeight: "600" },
    permBody: { color: colors.dim, fontSize: 12 },
    permDetailScroll: { maxHeight: 220, backgroundColor: colors.panel, borderRadius: radius.sm },
    permActions: { flexDirection: "row", gap: 10, marginTop: 4 },
    askQTabs: { flexDirection: "row", gap: 14, borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 6 },
    askQTab: { paddingBottom: 6, borderBottomWidth: 2, borderBottomColor: "transparent" },
    askQTabActive: { borderBottomColor: colors.busy },
    askQTabText: { color: colors.faint, fontSize: 12, fontWeight: "600" },
    askQTabTextActive: { color: colors.text },
    askQQuestion: { color: colors.text, fontSize: 14 },
    askQOptionRow: {
      backgroundColor: colors.panel,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 10,
      gap: 2,
    },
    askQOptionRowSelected: { borderColor: colors.busy, backgroundColor: withAlpha(colors.busy, 0.1) },
    askQOptionLabel: { color: colors.text, fontSize: 13, fontWeight: "600" },
    askQOptionDesc: { color: colors.faint, fontSize: 12 },
    askQOtherInput: {
      backgroundColor: colors.panel,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 10,
      color: colors.text,
      fontSize: 13,
    },
    todoRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, paddingVertical: 2 },
    todoText: { flex: 1, color: colors.text, fontSize: 12 },
    todoDone: { color: colors.faint, textDecorationLine: "line-through" },
    todoActive: { fontWeight: "600" },
    queueWrap: {
      backgroundColor: colors.inset,
      borderRadius: radius.md,
      marginHorizontal: 14,
      marginBottom: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      gap: 2,
    },
    queueLabel: { color: colors.faint, fontSize: 11 },
    queueItem: { color: colors.faint, fontSize: 12 },
    allowBtn: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 20, paddingVertical: 10 },
    allowText: { color: colors.accentFg, fontWeight: "700" },
    denyBtn: { backgroundColor: withAlpha(colors.danger, 0.14), borderRadius: radius.pill, paddingHorizontal: 20, paddingVertical: 10 },
    denyText: { color: colors.danger, fontWeight: "700" },
    optionsRow: { flexGrow: 0, paddingTop: 8 },
    optionsRowContent: { flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingBottom: 2 },
    optionPill: { backgroundColor: colors.inset, borderRadius: radius.pill, paddingHorizontal: 13, paddingVertical: 7 },
    optionPillText: { color: colors.dim, fontSize: 12, fontWeight: "600" },
    suggestBox: {
      marginHorizontal: 14,
      marginBottom: 6,
      backgroundColor: colors.panel,
      borderRadius: radius.md,
      overflow: "hidden",
      maxHeight: 160,
      ...softShadow(colors),
    },
    suggestRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    suggestName: { color: colors.accent, fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
    suggestDesc: { flex: 1, color: colors.dim, fontSize: 12 },
    composerWrap: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 10 },
    composerPill: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 4,
      backgroundColor: colors.panel,
      borderRadius: radius.xl,
      paddingLeft: 4,
      paddingRight: 4,
      paddingVertical: 4,
      ...softShadow(colors),
    },
    composerInput: {
      flex: 1,
      color: colors.text,
      fontSize: 15,
      paddingHorizontal: 8,
      paddingTop: 8,
      paddingBottom: 10,
      maxHeight: 120,
      textAlignVertical: "center",
      includeFontPadding: false,
    },
    roundIconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
    sendBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
    stopBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.danger, alignItems: "center", justifyContent: "center" },
    disabled: { opacity: 0.35 },
  });
