import {
  DEFAULT_EFFORT_KEY,
  DEFAULT_PERMISSION_MODE,
  resolveEffortKey,
  resolvePermissionMode,
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
  type FileChange,
  attachmentSource,
  type StepSummary,
  formatResumeAt,
  groupTurnBlocks,
  isBulkyToolPayload,
  turnFileChanges,
  modelFullName,
  modelMenuLabel,
  segmentImages,
} from "@renki/client-core";
import type { AttachmentView, CapabilitiesResponse, SessionResume } from "@renki/protocol";
import { Ionicons } from "@expo/vector-icons";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Markdown, StreamingMarkdown } from "../components/Markdown";
import { FadeIn, Skeleton, animateLayout } from "../components/Motion";
import { Sheet } from "../components/Sheet";
import { FileSheet, type OpenFile } from "../components/FileSheet";
import { FileLinkContext, type FileLinkTarget } from "../lib/fileLinks";
import { pickDocumentAttachments, pickImageAttachments, type PendingAttachment } from "../lib/attachments";
import { loadDeviceDefaults, rememberDeviceDefaults } from "../lib/composerPrefs";
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
  const scrollRef = useRef<FlatList<TimelineEntry>>(null);
  /*
   * Follow the newest output ONLY while the reader is already at the bottom
   * (same rule as the web client). Scrolling up is a deliberate act — reading
   * something further back — and a streaming reply that yanks you forward
   * makes the transcript unusable. The threshold absorbs sub-pixel rounding
   * and the last row's bottom padding, nothing more.
   */
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  /** While our own animated scrollToEnd is in flight, its intermediate scroll events must not un-stick us. */
  const jumpingUntil = useRef(0);
  const inputRef = useRef<TextInput>(null);
  const [text, setText] = useState("");
  /**
   * All three belong to the SESSION, not to this phone: they're pushed by the
   * daemon and written back through `rest.updateSessionComposer`, so a session
   * started here opens on a laptop set to exactly what was chosen here, and a
   * change on either device moves the other.
   *
   * These hold the mirrored value so a pick feels instant; this device's own
   * defaults fill in until the first push arrives and for any field the
   * session hasn't pinned.
   */
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

  // Capabilities and this device's defaults are fetched together so the
  // "default model from capabilities" fallback only runs once both are known —
  // otherwise a slow SecureStore read racing a fast capabilities fetch could
  // let the fallback stomp the device default. Whatever the SESSION has pinned
  // overrides both, applied by the effect below as soon as it's pushed.
  useEffect(() => {
    let live = true;
    Promise.all([
      loadDeviceDefaults(),
      rest.getCapabilities().catch((): CapabilitiesResponse => ({ models: [], commands: [] })),
    ]).then(([defaults, caps]) => {
      // Opening another session mid-read would otherwise apply this read to the
      // wrong screen.
      if (!live) return;
      setCapabilities(caps);
      setEffortKeyState(defaults.effortKey);
      setPermissionModeState(defaults.permissionMode);
      setModelState(defaults.model || caps.models[0]?.value || "");
    });
    return () => {
      live = false;
    };
  }, [rest, sessionId]);

  // Adopt whatever the session is pinned to whenever that actually changes: the
  // first push after opening, and any later change made on another device.
  // `conv.composer` only gets a new identity when a field really differs (see
  // RealtimeClient's sameComposer), so this can't fight an in-flight local
  // pick. A null field means nothing is pinned, so the device default stands.
  const composer = conv.composer;
  useEffect(() => {
    if (!composer) return;
    if (composer.model !== null) setModelState(composer.model);
    if (composer.effortKey !== null) setEffortKeyState(resolveEffortKey(composer.effortKey));
    if (composer.permissionMode !== null) setPermissionModeState(resolvePermissionMode(composer.permissionMode));
  }, [composer]);

  /**
   * Pin a pick onto the session and remember it as this device's default for
   * the next new one. The daemon echoes the change to every other client.
   *
   * A failed write is swallowed: the picker keeps the value locally and the
   * daemon's next push corrects it, which beats an error dialog for flicking a
   * sheet.
   */
  function pin(patch: { model?: string; effortKey?: string; permissionMode?: PermissionModeKey }) {
    rememberDeviceDefaults(patch);
    void rest.updateSessionComposer(sessionId, patch).catch(() => {});
  }

  function setModel(next: string) {
    setModelState(next);
    pin({ model: next });
  }

  function setEffortKey(next: string) {
    setEffortKeyState(next);
    pin({ effortKey: next });
  }

  function setPermissionMode(next: PermissionModeKey) {
    setPermissionModeState(next);
    pin({ permissionMode: next });
    // Matches the web: flipping to Auto mid-turn should stop the REST of that
    // turn asking again, not only change what the next one does.
    if (status === "busy" && isController) realtime.setPermissionMode(sessionId, next);
  }

  const isController = conv.controller === config.deviceId;
  const status = conv.status ?? "idle";
  // Sending mid-turn queues the prompt on the daemon, same as Enter on the web.
  const canSend = isController;
  /** Not "open" means what's on screen may be behind; say so rather than pass it off as live. */
  const connection = useStoreValue(realtime.status);

  /** A turn paused on a usage limit — only on the session snapshot, not in the event log. */
  const [resume, setResume] = useState<SessionResume | null>(null);
  /** The worktree's absolute path, so a reply's absolute file links can be mapped into it. */
  const [worktreePath, setWorktreePath] = useState<string | null>(null);
  /** Repo and branch as the session's row has them now — a session can be moved into a repo after it started (see the web's SessionView). */
  const [place, setPlace] = useState<{ repoName: string; branch: string | null } | null>(null);
  useEffect(() => {
    setResume(null);
    setWorktreePath(null);
    setPlace(null);
    return realtime.onSessionChanged((s) => {
      if (s.id !== sessionId) return;
      setResume(s.resume ?? null);
      setWorktreePath(s.worktreePath);
      setPlace({ repoName: s.repoName, branch: s.branch });
    });
  }, [realtime, sessionId]);
  const repoName = place?.repoName ?? conv.repoName;
  const branch = place ? place.branch : conv.branch;

  /**
   * A file a reply linked to, shown in a sheet. Links only open files while
   * the session still has its working tree; otherwise they're inert.
   */
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  useEffect(() => setOpenFile(null), [sessionId]);
  const hasTree = !!branch && conv.status !== "archived" && conv.status !== "trashed";
  const fileLinks = useMemo<FileLinkTarget | null>(
    () => (hasTree ? { worktreePath, onOpenFile: (path, line) => setOpenFile({ path, line }) } : null),
    [hasTree, worktreePath],
  );
  // Re-render every 30s so "today 15:31" turns into "shortly" on time.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!resume) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [resume]);

  // The list is inverted — newest at offset 0, the bottom — so "at the
  // bottom" is just a small offset, and new output stays in view by itself
  // without scrolling after every change.
  function onTimelineScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const stick = e.nativeEvent.contentOffset.y <= 24;
    if (!stick && Date.now() < jumpingUntil.current) return;
    stickToBottom.current = stick;
    setAtBottom((was) => (was === stick ? was : stick));
  }

  function jumpToLatest() {
    jumpingUntil.current = Date.now() + 600;
    stickToBottom.current = true;
    setAtBottom(true);
    scrollRef.current?.scrollToOffset({ offset: 0, animated: true });
  }

  // Opening a different session always starts at its newest output.
  useEffect(() => {
    stickToBottom.current = true;
    setAtBottom(true);
    scrollRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [sessionId]);

  /**
   * How many items the timeline had when it first showed content. Rows past
   * that are new since you opened the chat and fade in; the ones it opened
   * with, or that scroll into view later, just appear.
   */
  const settledCount = useRef<number | null>(null);
  const hadContentAtMount = useRef(conv.timeline.length > 0);
  if (settledCount.current === null && conv.timeline.length > 0) settledCount.current = conv.timeline.length;

  /** Newest first for the inverted list, each with its position in the timeline for a stable key. */
  const entries = useMemo(
    () => conv.timeline.map((item, index): TimelineEntry => ({ item, index })).reverse(),
    [conv.timeline],
  );

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

  const selectedModel = capabilities.models.find((m) => m.value === model);
  const modelLabel = selectedModel ? modelFullName(selectedModel) : "Default";

  return (
    <FileLinkContext.Provider value={fileLinks}>
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
            {repoName ?? "…"}
            {branch ? `:${branch}` : ""}
          </Text>
          <Text style={styles.headerSub}>
            {connection !== "open" && conv.status !== null ? (
              <>
                <View style={[styles.dot, { backgroundColor: colors.faint }]} /> reconnecting…
              </>
            ) : (
              <>
                <View style={[styles.dot, { backgroundColor: statusColor[status] ?? colors.faint }]} /> {status}
              </>
            )}
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
      <View style={styles.timelineWrap}>
        {/*
          Virtualised and inverted: only what's on screen (plus a little
          either side) is rendered, starting from the newest, so a chat with
          hundreds of turns opens as fast as a short one.
        */}
        <FadeIn
          key={conv.timeline.length > 0 ? "content" : "empty"}
          enabled={conv.timeline.length > 0 && !hadContentAtMount.current}
          distance={0}
          style={styles.timeline}
        >
        <FlatList
          ref={scrollRef}
          inverted
          data={entries}
          keyExtractor={entryKey}
          renderItem={({ item }) => (
            <TimelineRow
              item={item.item}
              colors={colors}
              styles={styles}
              onPreview={setPreviewAttachment}
              animate={settledCount.current !== null && item.index >= settledCount.current}
            />
          )}
          ItemSeparatorComponent={TimelineGap}
          style={styles.timeline}
          contentContainerStyle={styles.timelineContent}
          onScroll={onTimelineScroll}
          scrollEventThrottle={32}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={9}
        />
        </FadeIn>
        {conv.timeline.length === 0 && (
          <View style={styles.timelineEmpty} pointerEvents="none">
            {conv.status === null ? (
              <ConversationSkeleton />
            ) : (
              <FadeIn style={{ alignSelf: "center" }}>
                <Text style={styles.empty}>No messages yet.</Text>
              </FadeIn>
            )}
          </View>
        )}
        {/* Scrolled up while more arrives below: one tap back to the live end. */}
        {!atBottom && conv.timeline.length > 0 && (
          <FadeIn style={styles.jumpWrap} pointerEvents="box-none">
          <View style={styles.jumpWrapInner} pointerEvents="box-none">
            <TouchableOpacity style={styles.jump} onPress={jumpToLatest} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="Jump to latest">
              {status === "busy" ? (
                <>
                  <PulseDot color={colors.busy} />
                  <Text style={styles.jumpText}>Claude is writing</Text>
                </>
              ) : (
                <Text style={styles.jumpText}>Jump to latest</Text>
              )}
              <Ionicons name="arrow-down" size={14} color={colors.text} />
            </TouchableOpacity>
          </View>
          </FadeIn>
        )}
      </View>

      {/* Pending permissions */}
      {conv.pending.map((p) => (
        <FadeIn key={p.requestId}>
        <PermissionCard
          key={p.requestId}
          perm={p}
          canAct={isController}
          onDecide={(d, updatedInput) => realtime.resolvePermission(sessionId, p.requestId, d, updatedInput)}
          colors={colors}
          styles={styles}
        />
        </FadeIn>
      ))}

      {resume && status !== "busy" && (
        <FadeIn>
        <View style={styles.resumeWrap}>
          <Ionicons name="pause-circle" size={20} color={colors.busy} />
          <View style={{ flex: 1 }}>
            <Text style={styles.resumeTitle}>Paused · {formatResumeAt(resume.at)}</Text>
            <Text style={styles.resumeReason} numberOfLines={2}>
              {resume.reason}
              {resume.attempt > 0 ? ` Attempt ${resume.attempt + 1}.` : ""}
            </Text>
          </View>
          {/* Anyone may act once the lock has lapsed — see the daemon's resumeAction. */}
          {(isController || !conv.controller) && (
            <View style={styles.resumeActions}>
              <TouchableOpacity onPress={() => realtime.resumeAction(sessionId, "cancel")} hitSlop={8}>
                <Text style={styles.resumeCancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.resumeNowBtn} onPress={() => realtime.resumeAction(sessionId, "now")}>
                <Text style={styles.resumeNowText}>Now</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
        </FadeIn>
      )}

      {/* Queued prompts — kept out of the timeline so a fast follow-up can't
          render ahead of the turn it's replying to; shown here as "up next". */}
      {conv.queuedPrompts.length > 0 && (
        <FadeIn>
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
        </FadeIn>
      )}

      {/* Composer */}
      {suggestions.length > 0 && (
        <FadeIn distance={4}>
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
        </FadeIn>
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
              !isController ? "Take control to send prompts" : status === "busy" ? "Add to what Claude is doing…" : "Chat with Claude…"
            }
            placeholderTextColor={colors.faint}
          />
          {/* Mid-turn, Stop only while the composer is empty — once there's
              something to send, the button queues it instead. */}
          {isController && status === "busy" && !text.trim() && attachments.length === 0 ? (
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
        options={capabilities.models.map((m) => {
          const { title, subtitle } = modelMenuLabel(m);
          return { key: m.value, label: title, description: subtitle };
        })}
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
      <FileSheet sessionId={sessionId} file={openFile} onClose={() => setOpenFile(null)} />
    </KeyboardAvoidingView>
    </FileLinkContext.Provider>
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
  const { config } = useClient();
  const isImage = attachment.mediaType.startsWith("image/");
  return (
    <TouchableOpacity
      style={styles.attachChip}
      activeOpacity={isImage ? 0.7 : 1}
      disabled={!isImage}
      onPress={isImage ? () => onPreview?.(attachment) : undefined}
    >
      {isImage ? (
        <Image source={attachmentSource(attachment, config)} style={styles.attachThumb} />
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
  const { config } = useClient();
  return (
    <Modal transparent visible={attachment != null} animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={previewStyles.backdrop} activeOpacity={1} onPress={onClose}>
        {attachment && (
          <Image
            source={attachmentSource(attachment, config)}
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

/**
 * Images a tool handed back to Claude (a screenshot it took, a PNG it Read),
 * shown under the step outside its fold so progress is visible at a glance.
 */
function ToolImages({ images, styles }: { images: AttachmentView[]; styles: Styles }) {
  const [previewing, setPreviewing] = useState<AttachmentView | null>(null);
  if (images.length === 0) return null;
  const thumbs = images.map((img, i) => <ToolImageThumb key={i} image={img} styles={styles} onPress={() => setPreviewing(img)} />);
  return (
    <>
      {images.length === 1 ? (
        <View style={styles.toolImageRow}>{thumbs}</View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolImageRow}>
          {thumbs}
        </ScrollView>
      )}
      <ImagePreviewModal attachment={previewing} onClose={() => setPreviewing(null)} />
    </>
  );
}

const TOOL_IMAGE_HEIGHT = 160;

/** One thumbnail, sized to the image's own aspect ratio once it loads. */
function ToolImageThumb({ image, styles, onPress }: { image: AttachmentView; styles: Styles; onPress: () => void }) {
  const { config } = useClient();
  const [aspect, setAspect] = useState(4 / 3);
  const width = Math.min(TOOL_IMAGE_HEIGHT * aspect, 280);
  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={styles.toolImageThumb}>
      <Image
        source={attachmentSource(image, config)}
        style={{ width, height: TOOL_IMAGE_HEIGHT }}
        resizeMode="contain"
        accessibilityLabel={image.name}
        onLoad={(e) => {
          const { width: w, height: h } = e.nativeEvent.source;
          if (w > 0 && h > 0) setAspect(w / h);
        }}
      />
    </TouchableOpacity>
  );
}

/** A softly pulsing status dot — the web pill's `animate-pulse` equivalent. */
function PulseDot({ color }: { color: string }) {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: color, opacity }} />;
}

const previewStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", alignItems: "center", justifyContent: "center" },
  image: { width: "100%", height: "80%" },
  close: { position: "absolute", top: 48, right: 20 },
});

type TimelineEntry = { item: TimelineItem; index: number };

/** Turns and prompts keep their own ids; anything else keys on its place in the timeline. */
function entryKey(e: TimelineEntry): string {
  if (e.item.type === "turn") return `t:${e.item.turn.turnId}`;
  if (e.item.type === "prompt") return `p:${e.item.promptId}:${e.index}`;
  return `${e.item.type}:${e.index}`;
}

function TimelineGap() {
  return <View style={{ height: 14 }} />;
}

/**
 * Memoised: the reducer replaces only what changed, so while one turn streams
 * every other row gets the same object back and skips re-rendering.
 */
const TimelineRow = memo(function TimelineRow({
  item,
  colors,
  styles,
  onPreview,
  animate = false,
}: {
  item: TimelineItem;
  colors: ThemeColors;
  styles: Styles;
  onPreview: (a: Attachment) => void;
  /** Arrived since the chat opened: ease in rather than pop. */
  animate?: boolean;
}) {
  return (
    <FadeIn enabled={animate}>
      <TimelineRowBody item={item} colors={colors} styles={styles} onPreview={onPreview} />
    </FadeIn>
  );
});

function TimelineRowBody({
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
  if (item.type === "model_change") {
    return (
      <View style={styles.modelChangeRow}>
        <View style={styles.modelChangeRule} />
        <Text style={styles.modelChangeText}>Switched to {item.model ?? "the default model"}</Text>
        <View style={styles.modelChangeRule} />
      </View>
    );
  }
  if (item.type === "background_tasks") {
    return <BackgroundTasksRow tasks={item.tasks} styles={styles} />;
  }
  return <AssistantTurn turn={item.turn} colors={colors} styles={styles} />;
}

/**
 * The shape of a conversation while it loads — a message on the right, a
 * reply on the left — so the real one replaces it in place instead of
 * appearing out of an empty screen.
 */
function ConversationSkeleton() {
  return (
    <View style={{ alignSelf: "stretch", paddingHorizontal: 14, gap: 22 }} accessibilityLabel="Loading conversation">
      <View style={{ alignItems: "flex-end" }}>
        <Skeleton width="62%" height={44} radius={16} />
      </View>
      <View style={{ gap: 9 }}>
        <Skeleton width="38%" height={11} />
        <Skeleton width="92%" height={13} />
        <Skeleton width="80%" height={13} />
        <Skeleton width="86%" height={13} />
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Skeleton width="44%" height={36} radius={16} />
      </View>
      <View style={{ gap: 9 }}>
        <Skeleton width="30%" height={11} />
        <Skeleton width="88%" height={13} />
        <Skeleton width="70%" height={13} />
      </View>
    </View>
  );
}

/**
 * Background tasks with no tool call in view to attach to, folded into one
 * tappable line that opens to the list — one row however many land.
 */
function BackgroundTasksRow({
  tasks,
  styles,
}: {
  tasks: { summary: string; status: "completed" | "failed" | "stopped" }[];
  styles: Styles;
}) {
  const [open, setOpen] = useState(false);
  const failed = tasks.filter((t) => t.status === "failed").length;
  const label =
    tasks.length === 1
      ? `Background task finished: ${tasks[0]!.summary}`
      : `${tasks.length} background tasks finished${failed > 0 ? ` · ${failed} failed` : ""}${open ? "" : " ›"}`;
  return (
    <View style={styles.noticeWrap}>
      <TouchableOpacity disabled={tasks.length === 1} onPress={() => {
          animateLayout();
          setOpen((o) => !o);
        }}>
        <Text style={[styles.notice, failed > 0 && styles.noticeWarn]}>{label}</Text>
      </TouchableOpacity>
      {open &&
        tasks.map((t, i) => (
          <Text key={i} style={[styles.notice, t.status === "failed" && styles.noticeWarn]}>
            {t.status === "completed" ? "✓" : t.status === "stopped" ? "■" : "✕"} {t.summary}
          </Text>
        ))}
    </View>
  );
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
      {groupTurnBlocks(turn.blocks, new Set(turn.steeredPrompts.map((p) => p.afterBlockIndex))).map((seg) => {
        const last = seg.kind === "group" ? seg.items[seg.items.length - 1]!.index : seg.index;
        return (
          <Fragment key={seg.kind === "group" ? `g${seg.items[0]!.index}` : seg.index}>
            {seg.kind === "group" ? (
              <ToolGroup items={seg.items} summary={seg.summary} colors={colors} styles={styles} turnRunning={turn.status === "running"} />
            ) : (
              <Block block={seg.block} colors={colors} styles={styles} turnRunning={turn.status === "running"} />
            )}
            <ToolImages images={segmentImages(seg)} styles={styles} />
            {steeredAfter(last).map((p) => (
              <SteeredPrompt key={p.promptId} prompt={p} styles={styles} />
            ))}
          </Fragment>
        );
      })}
      {turn.status !== "running" && <FilesChanged changes={turnFileChanges(turn)} colors={colors} styles={styles} />}
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

/** A run of routine tool calls as one tappable line — "Ran 3 commands, edited 2 files +40 −3" — opening to the steps. */
function ToolGroup({
  items,
  summary,
  colors,
  styles,
  turnRunning,
}: {
  items: { index: number; block: BlockView }[];
  summary: StepSummary;
  colors: ThemeColors;
  styles: Styles;
  turnRunning: boolean;
}) {
  const [open, setOpen] = useState(false);
  const live = summary.running && turnRunning;
  return (
    <View style={styles.toolStep}>
      <TouchableOpacity style={styles.toolStepHeader} activeOpacity={0.7} onPress={() => {
          animateLayout();
          setOpen((o) => !o);
        }}>
        <Ionicons name="layers-outline" size={13} color={colors.faint} />
        <Text style={styles.toolStepLabel} numberOfLines={1}>
          {summary.text}
        </Text>
        {summary.added + summary.removed > 0 && (
          <Text style={styles.toolStepMeta} numberOfLines={1}>
            <Text style={{ color: colors.ok }}>+{summary.added}</Text> <Text style={{ color: colors.danger }}>−{summary.removed}</Text>
          </Text>
        )}
        {!(summary.added + summary.removed > 0) && <View style={{ flex: 1 }} />}
        {live ? (
          <Ionicons name="ellipsis-horizontal" size={13} color={colors.faint} />
        ) : summary.failed > 0 ? (
          <Ionicons name="close" size={13} color={colors.danger} />
        ) : (
          <Ionicons name="checkmark" size={13} color={colors.ok} />
        )}
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={12} color={colors.faint} />
      </TouchableOpacity>
      {open && (
        <View style={styles.toolStepBody}>
          {items.map((it) => (
            <Block key={it.index} block={it.block} colors={colors} styles={styles} turnRunning={turnRunning} />
          ))}
        </View>
      )}
    </View>
  );
}

/** The files a finished turn changed, each tappable to its diff. */
function FilesChanged({ changes, colors, styles }: { changes: FileChange[]; colors: ThemeColors; styles: Styles }) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  if (changes.length === 0) return null;
  return (
    <View style={styles.filesCard}>
      {changes.map((c) => (
        <View key={c.filePath}>
          <TouchableOpacity style={styles.toolStepHeader} onPress={() => {
              animateLayout();
              setOpenPath(openPath === c.filePath ? null : c.filePath);
            }}>
            <Ionicons name="document-outline" size={13} color={colors.faint} />
            <Text style={[styles.toolStepLabel, { flex: 1 }]} numberOfLines={1}>
              {c.filePath.split("/").filter(Boolean).slice(-2).join("/")}
            </Text>
            <Text style={{ color: colors.ok, fontSize: 11.5 }}>+{c.added}</Text>
            <Text style={{ color: colors.danger, fontSize: 11.5 }}>−{c.removed}</Text>
            <Ionicons name={openPath === c.filePath ? "chevron-up" : "chevron-down"} size={12} color={colors.faint} />
          </TouchableOpacity>
          {openPath === c.filePath && c.views.map((v, i) => <DiffView key={i} view={v} colors={colors} styles={styles} />)}
        </View>
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
  return <StreamingMarkdown content={block.text} streaming={turnRunning && block.endedAtMs == null} />;
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
  const command = block.toolName === "Bash" ? ((block.toolInput as { command?: string } | null)?.command ?? null) : null;
  // Whole-file Writes and long scripts stay folded, even while running — see isBulkyToolPayload.
  const bulky = isBulkyToolPayload(editView, command);
  const restingOpen = richPayload && !bulky && (agentRunning || block.subagent == null);
  const [open, setOpen] = useState((running && !bulky) || restingOpen);
  const userToggled = useRef(false);
  const wasRunning = useRef(running || agentRunning);
  useEffect(() => {
    const nowRunning = running || agentRunning;
    if (wasRunning.current && !nowRunning && !userToggled.current) setOpen(restingOpen);
    if (!wasRunning.current && nowRunning && !userToggled.current) setOpen((running && !bulky) || restingOpen);
    wasRunning.current = nowRunning;
  }, [running, agentRunning, restingOpen, bulky]);

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
          animateLayout();
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
      <TouchableOpacity style={styles.subagentHeader} onPress={() => {
          animateLayout();
          setExpanded((v) => !v);
        }}>
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
          {groupTurnBlocks(subagent.blocks).map((seg) => (
            <Fragment key={seg.kind === "group" ? `g${seg.items[0]!.index}` : seg.index}>
              {seg.kind === "group" ? (
                <ToolGroup
                  items={seg.items}
                  summary={seg.summary}
                  colors={colors}
                  styles={styles}
                  turnRunning={subagent.status === "running"}
                />
              ) : (
                <Block block={seg.block} colors={colors} styles={styles} turnRunning={subagent.status === "running"} />
              )}
              <ToolImages images={segmentImages(seg)} styles={styles} />
            </Fragment>
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
    timelineWrap: { flex: 1 },
    timeline: { flex: 1 },
    timelineContent: { padding: 14 },
    timelineEmpty: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 10 },
    jumpWrap: { position: "absolute", left: 0, right: 0, bottom: 12, alignItems: "center" },
    jumpWrapInner: { alignItems: "center" },
    jump: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      backgroundColor: colors.panel,
      borderRadius: radius.pill,
      paddingHorizontal: 14,
      paddingVertical: 9,
      ...softShadow(colors),
    },
    jumpText: { color: colors.text, fontSize: 13, fontWeight: "600" },
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
    toolImageRow: { flexDirection: "row", gap: 8 },
    toolImageThumb: {
      borderRadius: radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.inset,
      overflow: "hidden",
    },
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
    // A rule across the transcript where the model changed, so a reply's
    // author is never ambiguous when scrolling back through a session that
    // switched mid-way. The raw id is the label on purpose — a friendly name
    // would hide the version detail you switched for.
    modelChangeRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 2 },
    modelChangeRule: { flex: 1, height: 1, backgroundColor: colors.border },
    modelChangeText: { color: colors.faint, fontSize: 11 },
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
    filesCard: { backgroundColor: colors.inset, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 2, marginTop: 4 },
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
    resumeWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.panel,
      borderRadius: radius.md,
      marginHorizontal: 14,
      marginBottom: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    resumeTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
    resumeReason: { color: colors.dim, fontSize: 12, marginTop: 1 },
    resumeActions: { flexDirection: "row", alignItems: "center", gap: 12 },
    resumeCancel: { color: colors.dim, fontSize: 13, fontWeight: "600" },
    resumeNowBtn: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 6 },
    resumeNowText: { color: colors.accentFg, fontSize: 13, fontWeight: "700" },
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
