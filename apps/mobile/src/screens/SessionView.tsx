import {
  DEFAULT_EFFORT_KEY,
  DEFAULT_PERMISSION_MODE,
  resolveEffortKey,
  resolvePermissionMode,
  EFFORT_LEVELS,
  estimateTokens,
  formatCost,
  formatTokenCount,
  formatAgo,
  formatTurnDuration,
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_PROMPT_ATTACHMENT_BYTES,
  attachmentBytes,
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
  type MacBuildView,
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
  PUSH_PROMPT,
  PULL_PROMPT,
  behindSummary,
  promptOptsFor,
  unpushedSummary,
  groupTurnBlocks,
  isBulkyToolPayload,
  turnFileChanges,
  turnActivity,
  turnTodos,
  suggestedReplies,
  backgroundWorkOf,
  modelFullName,
  pickableModel,
  modelMenuLabel,
  segmentImages,
  agentMapOf,
  backgroundTasksOf,
  timelineWithSending,
} from "@renki/client-core";
import type { AttachmentView, CapabilitiesResponse, Session, SessionResume } from "@renki/protocol";
import { Ionicons } from "@expo/vector-icons";
import { createContext, Fragment, memo, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
  Keyboard,
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
import { LongPressToRead } from "../components/TextReader";
import { Markdown, StreamingMarkdown } from "../components/Markdown";
import { FadeIn, PulseDot, Skeleton, animateLayout } from "../components/Motion";
import { AgentsSheet } from "../components/AgentsSheet";
import { GenUiReplyContext } from "../components/GenUi";
import { BackgroundWorkBar, GitBanner, TrashedBanner } from "../components/ChatBars";
import { Sheet } from "../components/Sheet";
import { FileSheet, type OpenFile } from "../components/FileSheet";
import { SessionToolsSheet } from "../components/SessionToolsSheet";
import { ImageViewer } from "../components/ImageViewer";
import { SearchFlash, SearchFlashContext, type SearchFlashTarget, SearchMatchText } from "../components/SearchFlash";
import { FileLinkContext, type FileLinkTarget } from "../lib/fileLinks";
import { pickDocumentAttachments, pickImageAttachments, type PendingAttachment, type Picked } from "../lib/attachments";
import { formatBytes, uploadFile } from "../lib/upload";
import type { UploadRef } from "@renki/protocol";
import { loadDeviceDefaults, rememberDeviceDefaults } from "../lib/composerPrefs";
import { clearDraft, loadDraft, saveDraft } from "../lib/drafts";
import { randomUUID } from "expo-crypto";
import { useClient, useStoreValue } from "../lib/client";
import { ExportSheet } from "../components/ExportSheet";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { radius, softShadow, statusColorFor, type ThemeColors, useTheme, withAlpha } from "../theme";

export function SessionView({
  sessionId,
  onBack,
  jumpTo,
  onJumped,
}: {
  sessionId: string;
  onBack: () => void;
  /** Opened from search: the hit's anchor (`searchHitAnchor`) and the query, to scroll to and mark. */
  jumpTo?: { anchor: string; query: string } | null;
  /** Called once the hit is found, so the chat behaves normally from then on. */
  onJumped?: () => void;
}) {
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
  /** Files going by reference (too big for inline, or another kind): uploaded as soon as they're picked. Not kept in drafts. */
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const uploadCancels = useRef(new Map<string, () => void>());
  const uploading = uploads.some((u) => !u.ref && !u.error);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [effortSheetOpen, setEffortSheetOpen] = useState(false);
  const [modeSheetOpen, setModeSheetOpen] = useState(false);
  /** The image viewer: every image of the message tapped, opened on the one tapped. */
  const [preview, setPreview] = useState<{ images: Attachment[]; index: number } | null>(null);
  const openPreview = useMemo<OpenPreview>(() => (images, index) => setPreview({ images, index }), []);

  useEffect(() => {
    realtime.watch(sessionId);
    return () => realtime.unwatch(sessionId);
  }, [realtime, sessionId]);

  // What you typed here and haven't sent comes back when you return (see lib/drafts).
  // Nothing is saved until the stored draft has been read, so an empty composer can't overwrite it.
  const draftLoaded = useRef(false);
  const draftNow = useRef({ text: "", attachments: [] as PendingAttachment[] });
  draftNow.current = { text, attachments };
  useEffect(() => {
    let cancelled = false;
    draftLoaded.current = false;
    void loadDraft(sessionId).then((draft) => {
      if (cancelled) return;
      if (draft) {
        setText((t) => t || draft.text);
        setAttachments((prev) => (prev.length > 0 ? prev : draft.attachments.map((a) => ({ ...a, id: randomUUID() }))));
        if (draft.attachmentsDropped) setAttachError("Your draft's attachments were too large to keep. Attach them again.");
      }
      draftLoaded.current = true;
    });
    return () => {
      cancelled = true;
      if (!draftLoaded.current) return;
      const { text: t, attachments: a } = draftNow.current;
      saveDraft(sessionId, t, a.map(({ id: _id, ...rest }) => rest));
    };
  }, [sessionId]);
  useEffect(() => {
    if (!draftLoaded.current) return;
    const id = setTimeout(() => saveDraft(sessionId, text, attachments.map(({ id: _id, ...a }) => a)), 250);
    return () => clearTimeout(id);
  }, [sessionId, text, attachments]);

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
      setModelState(pickableModel(defaults.model, caps.models));
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
    if (composer.model !== null) setModelState(pickableModel(composer.model, capabilities.models));
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
  /** One-tap answers to the question the newest turn ended on, unless closed with its X. */
  const [dismissedReplies, setDismissedReplies] = useState<string | null>(null);
  const suggestion = useMemo(() => suggestedReplies(conv), [conv.timeline, conv.sendingPrompts, conv.queuedPrompts]);
  const replies =
    suggestion && suggestion.turnId !== dismissedReplies && status !== "archived" && status !== "trashed"
      ? suggestion
      : null;
  // Sending mid-turn queues the prompt on the daemon, same as Enter on the web.
  // Not holding control doesn't stop you: sending takes it (see takeOver).
  const canSend = status !== "archived" && status !== "trashed";
  /** The daemon hasn't reported yet: typing and attaching are fine meanwhile; only sending waits. */
  const loading = conv.status === null;
  /** Not "open" means what's on screen may be behind; say so rather than pass it off as live. */
  const connection = useStoreValue(realtime.status);

  // Nobody holding the lock (the idle sweep released it) means there's nothing to wait on — claim it rather than
  // making the reader tap "Take control". Same as the web: only fires when it's vacant, never steals.
  const vacant = conv.status !== null && !conv.controller;
  const claimable = status !== "trashed" && status !== "archived";
  useEffect(() => {
    if (vacant && claimable && connection === "open") realtime.takeControl(sessionId);
  }, [vacant, claimable, connection, realtime, sessionId]);

  /** A turn paused on a usage limit — only on the session snapshot, not in the event log. */
  const [resume, setResume] = useState<SessionResume | null>(null);
  /** Which resume button was tapped, until the daemon answers with a new resume (or none). */
  const [resumeSent, setResumeSent] = useState<"cancel" | "now" | null>(null);
  useEffect(() => setResumeSent(null), [resume?.at, resume?.attempt, resume?.kind]);
  /**
   * Stop was tapped and the turn hasn't ended yet. Interrupting can take a
   * moment (a tool call has to wind down), and a button that just sat there
   * got tapped again.
   */
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (status !== "busy") setStopping(false);
  }, [status]);
  const [unarchiving, setUnarchiving] = useState(false);
  /** The worktree's absolute path, so a reply's absolute file links can be mapped into it. */
  const [worktreePath, setWorktreePath] = useState<string | null>(null);
  /** Repo and branch as the session's row has them now — a session can be moved into a repo after it started (see the web's SessionView). */
  const [place, setPlace] = useState<{ repoName: string; branch: string | null } | null>(null);
  /** The chat's title: what the header shows (repo and branch are already in the list, and take room the header doesn't have). */
  const [title, setTitle] = useState<string | null>(null);
  /** Commits and uncommitted files GitHub doesn't have yet (counted by the daemon after each turn). */
  const [unpushed, setUnpushed] = useState<Session["unpushed"]>(null);
  /** Commits on GitHub's base branch this branch lacks, unless the daemon catches it up on its own. */
  const [behind, setBehind] = useState<{ commits: number; base: string | null } | null>(null);
  /** When a trashed session is deleted for good, for the trash banner's countdown. */
  const [purgeAt, setPurgeAt] = useState<number | null>(null);
  /** False once the controller's last connection closed; it can't answer approvals then, so anyone may. */
  const [controllerOnline, setControllerOnline] = useState(true);
  useEffect(() => {
    setControllerOnline(true);
    setResume(null);
    setWorktreePath(null);
    setPlace(null);
    setTitle(null);
    setUnpushed(null);
    setBehind(null);
    setPurgeAt(null);
    return realtime.onSessionChanged((s) => {
      if (s.id !== sessionId) return;
      setTitle(s.title);
      setUnpushed(s.unpushed ?? null);
      setBehind(s.behind ? { commits: s.behind.commits, base: s.baseBranch } : null);
      setPurgeAt(s.purgeAt ?? null);
      setResume(s.resume ?? null);
      setWorktreePath(s.worktreePath);
      setPlace({ repoName: s.repoName, branch: s.branch });
      setControllerOnline(s.controllerOnline ?? true);
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
  /** Every live session has a folder to browse; only one in a repo has changes to diff. */
  const hasFiles = conv.status !== "archived" && conv.status !== "trashed";
  const hasTree = !!branch && hasFiles;
  const fileLinks = useMemo<FileLinkTarget | null>(
    () => (hasFiles ? { worktreePath, onOpenFile: (path, line) => setOpenFile({ path, line }) } : null),
    [hasFiles, worktreePath],
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
  // without scrolling after every change. Scrolled up, the FlatList's
  // maintainVisibleContentPosition keeps it from moving under you.
  //
  // Your finger decides, not a distance: touching the list to scroll lets go
  // of the bottom at once, and only coming to rest right at it again (or
  // Jump to latest, or sending) holds it again. A distance alone was too
  // eager: anywhere near the bottom, a streaming reply kept pulling you down
  // before a drag could get away from it.
  const dragging = useRef(false);
  function setStick(stick: boolean) {
    stickToBottom.current = stick;
    setAtBottom((was) => (was === stick ? was : stick));
  }
  function onTimelineScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const y = e.nativeEvent.contentOffset.y;
    scrollOffset.current = y;
    if (stickToBottom.current) {
      if (y > 24 && Date.now() >= jumpingUntil.current) setStick(false);
    } else if (y <= 2 && !dragging.current) setStick(true);
  }
  function onTimelineDragStart() {
    dragging.current = true;
    jumpingUntil.current = 0;
    setStick(false);
  }
  function onTimelineSettle(e: NativeSyntheticEvent<NativeScrollEvent>) {
    dragging.current = false;
    if (e.nativeEvent.contentOffset.y <= 8) setStick(true);
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
  /**
   * Items before the loaded ones, still on their way: the chat opens with its
   * latest turns and client-core fetches the rest. Positions count from the
   * start of the whole chat, so keys stay put as history arrives in front
   * (at the list's far end, being inverted, so nothing on screen moves).
   */
  const older = conv.olderItems ?? 0;
  if (settledCount.current === null && conv.timeline.length > 0) settledCount.current = older + conv.timeline.length;

  /** The timeline plus any message sent from here that the daemon hasn't confirmed yet (shown instantly). */
  const rows = useMemo(() => timelineWithSending(conv), [conv.timeline, conv.sendingPrompts, conv.queuedPrompts]);
  /** Newest first for the inverted list, each with its position in the whole chat for a stable key. */
  const entries = useMemo(() => rows.map((item, i): TimelineEntry => ({ item, index: older + i })).reverse(), [rows, older]);
  /**
   * Opened from search: once the hit's row is in the timeline, scroll to it
   * (rows far back aren't rendered yet, hence the index and the fallback in
   * onScrollToIndexFailed), then mark it. The mark measures where it landed
   * and the list brings it to the middle. Opening a chat any other way skips
   * all of this.
   */
  const timelineRef = useRef<View>(null);
  const scrollOffset = useRef(0);
  const [flash, setFlash] = useState<SearchFlashTarget | null>(null);
  const jumpIndex = useRef<number | null>(null);
  const jumpRetries = useRef(0);
  const handledJump = useRef<object | null>(null);
  useEffect(() => {
    if (!jumpTo || handledJump.current === jumpTo) return;
    const found = findSearchAnchor(entries, jumpTo.anchor);
    if (!found) return;
    handledJump.current = jumpTo;
    stickToBottom.current = false;
    setAtBottom(false);
    jumpIndex.current = found.index;
    jumpRetries.current = 0;
    scrollRef.current?.scrollToIndex({ index: found.index, viewPosition: 0.5, animated: false });
    setFlash({ anchor: found.anchor, query: jumpTo.query, onPlaced: centerSearchHit });
    onJumped?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, jumpTo, onJumped]);
  // The query stays marked for a few seconds, as on the web.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  /** Moves the marked view to the middle of the timeline, or its top near the top when it's taller than that. */
  function centerSearchHit(y: number, height: number) {
    timelineRef.current?.measureInWindow((_x, top, _w, visible) => {
      const target = height < visible * 0.8 ? top + visible / 2 - height / 2 : top + 24;
      const delta = y - target;
      if (Math.abs(delta) < 8) return;
      // Inverted: a bigger offset moves the content down, so a hit below its spot needs a smaller one.
      scrollRef.current?.scrollToOffset({ offset: Math.max(0, scrollOffset.current - delta), animated: true });
    });
  }

  /**
   * "Show in transcript" from the agents sheet, as on the web: open every
   * tool row on the way to the call (the step group it's folded into, the
   * agents it's nested in), scroll its turn into view and flash the row. The
   * flash reuses the search jump's: the marked row measures where it landed
   * and the list brings it to the middle.
   */
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  function revealTool(toolUseId: string) {
    let index = -1;
    let path: string[] | null = null;
    for (let i = 0; i < entries.length && !path; i++) {
      const item = entries[i]!.item;
      if (item.type !== "turn") continue;
      path = pathToTool(item.turn.blocks, toolUseId);
      if (path) index = i;
    }
    if (!path) return;
    stickToBottom.current = false;
    setAtBottom(false);
    jumpIndex.current = index;
    jumpRetries.current = 0;
    scrollRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false });
    setReveal({ ids: new Set(path) });
    setFlash({ anchor: `u:${toolUseId}`, query: "", onPlaced: centerSearchHit });
  }
  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(() => setReveal(null), 4000);
    return () => clearTimeout(t);
  }, [reveal]);

  /** The session's subagents as a tree — the header's Agents button and sheet. */
  const agents = useMemo(() => agentMapOf(conv.timeline), [conv.timeline]);
  /** Commands sent to run in the background (the web's agent map lists them too). */
  const commands = useMemo(() => backgroundTasksOf(conv.timeline).filter((t) => t.kind === "command"), [conv.timeline]);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const background = useMemo(() => backgroundWorkOf(conv.timeline), [conv.timeline]);
  /** Push and pull only make sense on a live session that isn't mid-turn. */
  const syncable = conv.status !== null && status !== "busy" && status !== "archived" && status !== "trashed";
  const syncRows = [
    ...(behind && syncable
      ? [{ key: "pull", icon: "cloud-download-outline" as const, label: behindSummary(behind.commits, behind.base), action: "Pull", prompt: PULL_PROMPT }]
      : []),
    ...(unpushed && syncable ? [{ key: "push", icon: "cloud-upload-outline" as const, label: unpushedSummary(unpushed), action: "Push", prompt: PUSH_PROMPT }] : []),
  ];
  /** What the ⋯ button's dot says: agents still running beat work to push or pull. */
  const menuBadge: "running" | "sync" | null = background.length > 0 ? "running" : syncRows.length > 0 ? "sync" : null;
  const [exportOpen, setExportOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  const effort = EFFORT_LEVELS.find((e) => e.key === effortKey) ?? EFFORT_LEVELS[0];
  const mode = PERMISSION_MODES.find((m) => m.key === permissionMode) ?? PERMISSION_MODES[0];
  const suggestions =
    text.startsWith("/") && text.length > 1 && !text.includes(" ")
      ? capabilities.commands.filter((c) => c.name.toLowerCase().startsWith(text.slice(1).toLowerCase()))
      : [];

  /**
   * Acting on the chat from here takes control first, instead of asking you
   * to: it's your own devices, and a step before every message on the other
   * one was only friction. The daemon handles messages in order, so the
   * prompt that follows arrives with control already here.
   */
  function takeOver() {
    if (!isController) realtime.takeControl(sessionId);
  }
  /** A renki-ui choice button tapped in a reply: sent as your next message, like a suggested reply. */
  const genUiReply = useCallback(
    (t: string) => {
      if (!isController) realtime.takeControl(sessionId);
      realtime.submitPrompt(sessionId, t, promptOptsFor(conv.composer));
    },
    [isController, realtime, sessionId, conv.composer],
  );
  const sendNow = useMemo(
    () => () => {
      if (!isController) realtime.takeControl(sessionId);
      realtime.sendNow(sessionId);
    },
    [isController, realtime, sessionId],
  );

  function send() {
    const t = text.trim();
    if ((!t && attachments.length === 0 && uploads.length === 0) || !canSend) return;
    // Big files must finish uploading first; one that failed has to be removed or picked again.
    if (uploading) return setAttachError("Wait for the upload to finish.");
    if (uploads.some((u) => u.error)) return setAttachError("Remove the file that didn't upload, or pick it again.");
    const refs = uploads.map((u) => u.ref!);
    takeOver();
    realtime.submitPrompt(sessionId, t, {
      model: model || undefined,
      maxThinkingTokens: effort?.maxThinkingTokens ?? undefined,
      permissionMode,
      attachments: attachments.length > 0 ? attachments.map(({ id: _id, ...a }) => a) : undefined,
      uploads: refs.length > 0 ? refs : undefined,
    });
    setText("");
    setAttachments([]);
    setUploads([]);
    setAttachError(null);
    clearDraft(sessionId);
  }

  /** Appends whatever came back from a picker, surfacing the first error (if any) below the composer. */
  function addPicked(results: Picked[]) {
    const errors = results.filter((r): r is { error: string } => "error" in r).map((r) => r.error);
    // The whole message has to fit in one API request (as on the web); inline
    // files past that go by reference instead of being dropped. A file read
    // inline already sits in memory, so it isn't re-uploaded: its data is.
    let total = attachments.reduce((sum, a) => sum + attachmentBytes(a), 0);
    const accepted: PendingAttachment[] = [];
    for (const r of results) {
      if ("error" in r) continue;
      if ("upload" in r) {
        startUpload(r.upload.uri, r.upload.name, r.upload.size);
        continue;
      }
      if (total + attachmentBytes(r) > MAX_PROMPT_ATTACHMENT_BYTES) {
        errors.unshift(`Attachments can be ${MAX_PROMPT_ATTACHMENT_BYTES / (1024 * 1024)}MB per message in total. Dropped ${r.name}.`);
        continue;
      }
      total += attachmentBytes(r);
      accepted.push(r);
    }
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
    setAttachError(errors[0] ?? null);
  }

  /** Streams one picked file to the daemon in the background, its chip showing how far it's got. */
  function startUpload(uri: string, name: string, size: number | undefined) {
    const id = randomUUID();
    setUploads((prev) => [...prev, { id, name, size: size ?? 0, progress: 0 }]);
    const { done, cancel } = uploadFile(uri, name, config, (progress) =>
      setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, progress } : u))),
    );
    uploadCancels.current.set(id, cancel);
    done
      .then((ref) => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ref, size: ref.size, progress: 1 } : u))))
      .catch((err: Error) => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, error: err.message } : u))))
      .finally(() => uploadCancels.current.delete(id));
  }

  function removeUpload(id: string) {
    uploadCancels.current.get(id)?.();
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }

  async function attachPhoto() {
    setAttachMenuOpen(false);
    const room = MAX_ATTACHMENTS_PER_PROMPT - attachments.length - uploads.length;
    if (room <= 0) return setAttachError(`Up to ${MAX_ATTACHMENTS_PER_PROMPT} attachments per message.`);
    addPicked(await pickImageAttachments(room));
  }

  async function attachDocument() {
    setAttachMenuOpen(false);
    const room = MAX_ATTACHMENTS_PER_PROMPT - attachments.length - uploads.length;
    if (room <= 0) return setAttachError(`Up to ${MAX_ATTACHMENTS_PER_PROMPT} attachments per message.`);
    addPicked(await pickDocumentAttachments(room));
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function pickSuggestion(name: string) {
    setText(`/${name} `);
  }

  const [focused, setFocused] = useState(false);
  const composerOpen = focused || text.length > 0 || attachments.length > 0 || uploads.length > 0;
  // Mid-turn, Stop only while the composer is empty: once there's something
  // to send, the button queues it instead.
  /**
   * Opens one of the composer's sheets with the keyboard put away first: a Modal shown while the
   * keyboard was still closing sometimes came up with a 0x0 root, its contents squashed into the
   * screen's top-left corner instead of the sheet.
   */
  const openSheet = (open: (v: boolean) => void) => {
    Keyboard.dismiss();
    open(true);
  };

  const sendButton =
    status === "busy" && !text.trim() && attachments.length === 0 && uploads.length === 0 ? (
      <TouchableOpacity
        key="send"
        style={styles.stopBtn}
        disabled={stopping}
        onPress={() => {
          setStopping(true);
          takeOver();
          realtime.interrupt(sessionId);
        }}
        accessibilityLabel={stopping ? "Stopping" : "Stop"}
      >
        {stopping ? <ActivityIndicator size="small" color={colors.accentFg} /> : <Ionicons name="stop" size={15} color={colors.accentFg} />}
      </TouchableOpacity>
    ) : (
      <TouchableOpacity
        key="send"
        style={[styles.sendBtn, (!canSend || uploading || (!text.trim() && attachments.length === 0 && uploads.length === 0)) && styles.disabled]}
        disabled={!canSend || uploading || (!text.trim() && attachments.length === 0 && uploads.length === 0)}
        onPress={send}
        accessibilityLabel="Send"
      >
        <Ionicons name="arrow-up" size={19} color={colors.accentFg} />
      </TouchableOpacity>
    );

  const selectedModel = capabilities.models.find((m) => m.value === model);
  const modelLabel = selectedModel ? modelFullName(selectedModel) : model || "Default";

  return (
    <FileLinkContext.Provider value={fileLinks}>
    {/*
      keyboard-controller's, not React Native's: it follows the keyboard frame
      by frame on Android too, so the composer slides up with it instead of
      jumping once the keyboard is already open.
    */}
    <KeyboardAvoidingView style={[styles.fill, { paddingTop: insets.top + 10 }]} behavior="padding" keyboardVerticalOffset={0}>
      {/*
        Header: back, the title and the chat's menu, as in the Claude app.
        Status, agents and push/pull live in the ⋯ sheet, which carries a dot
        when something there wants a look.
      */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backRow} onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        {/* The title opens the chat's menu, like the ⋯ beside it. */}
        <TouchableOpacity style={styles.headerCenter} onPress={() => openSheet(setToolsOpen)} activeOpacity={0.6}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title || repoName || " "}
          </Text>
          {/* Only when it isn't live: what's on screen may be behind. */}
          {connection !== "open" && conv.status !== null && <Text style={styles.headerSub}>Reconnecting…</Text>}
        </TouchableOpacity>
        {conv.status === "archived" && (
          // Archived sessions can't be controlled; bringing one back rebuilds its worktree and resumes the chat.
          <TouchableOpacity
            style={[styles.ctrlBtn, unarchiving && styles.disabled]}
            disabled={unarchiving}
            onPress={() => {
              setUnarchiving(true);
              rest
                .unarchiveSession(sessionId)
                .then(() => realtime.takeControl(sessionId))
                .catch((err) => Alert.alert("Couldn't unarchive", err instanceof Error ? err.message : "Try again in a moment."))
                .finally(() => setUnarchiving(false));
            }}
          >
            <Text style={styles.ctrlBtnText}>{unarchiving ? "Unarchiving…" : "Unarchive"}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={() => openSheet(setToolsOpen)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={menuBadge ? "More, something needs a look" : "More"}
          style={styles.menuBtn}
        >
          <Ionicons name="ellipsis-horizontal" size={20} color={colors.text} />
          {menuBadge === "running" && (
            <View style={styles.menuBadge}>
              <PulseDot color={colors.ok} size={7} />
            </View>
          )}
          {menuBadge === "sync" && <View style={[styles.menuBadge, styles.menuBadgeDot, { backgroundColor: colors.accent }]} />}
        </TouchableOpacity>
      </View>

      {/* In the trash: when it goes and the way back; the transcript below stays readable. */}
      {conv.status === "trashed" && <TrashedBanner sessionId={sessionId} purgeAt={purgeAt} />}

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
        tap is also trying to scroll.
      */}
      <View style={styles.timelineWrap} ref={timelineRef}>
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
        <SearchFlashContext.Provider value={flash}>
        <SendNowContext.Provider value={sendNow}>
        <GenUiReplyContext.Provider value={canSend ? genUiReply : null}>
        <RevealContext.Provider value={reveal}>
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
              onPreview={openPreview}
              animate={settledCount.current !== null && item.index >= settledCount.current}
              afterNotice={item.item.type === "notice" && rows[item.index - older - 1]?.type === "notice"}
            />
          )}
          ItemSeparatorComponent={TimelineGap}
          // Inverted, so the footer is the top: where older history is still arriving.
          ListFooterComponent={older > 0 ? <OlderLoading styles={styles} colors={colors} /> : TimelineAnchor}
          // The list is inverted, so its header sits at the bottom, right under the newest reply.
          ListHeaderComponent={
            replies ? (
              <SuggestedReplies
                question={replies.question}
                replies={replies.replies}
                onPick={(r) => {
                  takeOver();
                  realtime.submitPrompt(sessionId, r, promptOptsFor(conv.composer));
                }}
                onDismiss={() => setDismissedReplies(replies.turnId)}
                colors={colors}
                styles={styles}
              />
            ) : null
          }
          style={styles.timeline}
          contentContainerStyle={styles.timelineContent}
          onScroll={onTimelineScroll}
          onScrollBeginDrag={onTimelineDragStart}
          onScrollEndDrag={onTimelineSettle}
          onMomentumScrollEnd={onTimelineSettle}
          scrollEventThrottle={32}
          // Scrolled up, the newest row (index 0) growing as a reply streams
          // would push everything you're reading off-screen. Anchor on the
          // first visible row past it instead (or the empty footer, when the
          // reply is the only row), so the view holds still. At the bottom,
          // leave it off: the inverted list already follows on its own.
          maintainVisibleContentPosition={atBottom ? undefined : { minIndexForVisible: 1 }}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={9}
          // Only a search jump scrolls by index: land near the row by its average height, then try again.
          onScrollToIndexFailed={(info) => {
            scrollRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            setTimeout(() => {
              if (jumpIndex.current !== info.index || jumpRetries.current++ >= 5) return;
              scrollRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: false });
            }, 100);
          }}
        />
        </RevealContext.Provider>
        </GenUiReplyContext.Provider>
        </SendNowContext.Provider>
        </SearchFlashContext.Provider>
        </FadeIn>
        {rows.length === 0 && (
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
        {!atBottom && rows.length > 0 && (
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
          // An absent or vacant controller can't answer, so this device may (the daemon hands it control as it answers).
          canAct
          controllerName={conv.controllerName ?? conv.controller}
          onTakeControl={() => realtime.takeControl(sessionId)}
          onDecide={(d, updatedInput) => {
            takeOver();
            realtime.resolvePermission(sessionId, p.requestId, d, updatedInput);
          }}
          colors={colors}
          styles={styles}
        />
        </FadeIn>
      ))}

      {resume && conv.status !== null && status !== "busy" && (
        <FadeIn>
        <View style={styles.resumeWrap}>
          <Ionicons name={resume.kind === "restart" ? "refresh-circle" : "pause-circle"} size={20} color={resume.kind === "restart" ? colors.dim : colors.busy} />
          <View style={{ flex: 1 }}>
            <Text style={styles.resumeTitle}>
              {resume.kind === "restart" ? "Continuing after a restart" : "Paused"} · {formatResumeAt(resume.at)}
            </Text>
            <Text style={styles.resumeReason} numberOfLines={2}>
              {resume.reason}
              {resume.attempt > 0 ? ` Attempt ${resume.attempt + 1}.` : ""}
            </Text>
          </View>
          {/* Acting takes control first (takeOver), so these are always there. */}
          {(
            <View style={styles.resumeActions}>
              <TouchableOpacity
                style={resumeSent !== null && resumeSent !== "cancel" && styles.disabled}
                disabled={resumeSent !== null}
                onPress={() => {
                  setResumeSent("cancel");
                  takeOver();
                  realtime.resumeAction(sessionId, "cancel");
                }}
                hitSlop={8}
              >
                <Text style={styles.resumeCancel}>{resumeSent === "cancel" ? "Cancelling…" : "Cancel"}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.resumeNowBtn, resumeSent !== null && resumeSent !== "now" && styles.disabled]}
                disabled={resumeSent !== null}
                onPress={() => {
                  setResumeSent("now");
                  takeOver();
                  realtime.resumeAction(sessionId, "now");
                }}
              >
                <Text style={styles.resumeNowText}>{resumeSent === "now" ? "Continuing…" : "Now"}</Text>
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

      {/* Background work and push/pull: one slim line each, only while there's something to say. */}
      {background.length > 0 && <BackgroundWorkBar work={background} onPress={() => openSheet(setAgentsOpen)} />}
      {syncRows.map((r) => (
        <GitBanner
          key={r.key}
          icon={r.icon}
          text={r.label}
          action={r.action}
          onAction={() => {
            takeOver();
            stickToBottom.current = true;
            setAtBottom(true);
            realtime.submitPrompt(sessionId, r.prompt, promptOptsFor(conv.composer));
          }}
        />
      ))}

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
      {(attachments.length > 0 || uploads.length > 0) && (
        <View style={styles.pendingAttachRow}>
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              colors={colors}
              styles={styles}
              onRemove={() => removeAttachment(a.id)}
              onPreview={(a) => previewAmong(attachments, a, openPreview)}
            />
          ))}
          {uploads.map((u) => (
            <UploadChip key={u.id} upload={u} colors={colors} styles={styles} onRemove={() => removeUpload(u.id)} />
          ))}
        </View>
      )}
      {attachError && <Text style={styles.attachError}>{attachError}</Text>}
      {/*
        Composer, as in the Claude app: a slim pill while you read, opening
        into two rows while you write, the second with the model and effort.
        The input keeps its place (and its key) in both, so it never remounts
        and drops the keyboard.
      */}
      <View style={styles.composerWrap}>
        <View style={[styles.composerPill, composerOpen && styles.composerPillOpen]}>
          <View style={styles.composerRow}>
            {!composerOpen && (
              <TouchableOpacity key="add" style={styles.roundIconBtn} onPress={() => openSheet(setAttachMenuOpen)} accessibilityLabel="Add to chat">
                <Ionicons name="add" size={22} color={colors.text} />
              </TouchableOpacity>
            )}
            <TextInput
              key="input"
              ref={inputRef}
              style={[styles.composerInput, composerOpen && styles.composerInputOpen]}
              value={text}
              onChangeText={setText}
              multiline
              onFocus={() => {
                animateLayout();
                setFocused(true);
              }}
              onBlur={() => {
                animateLayout();
                setFocused(false);
              }}
              placeholder={status === "busy" ? "Add to what Claude is doing…" : "Reply to Claude…"}
              placeholderTextColor={colors.faint}
            />
            {!composerOpen && sendButton}
          </View>
          {composerOpen && (
            <View style={styles.composerRow}>
              <TouchableOpacity style={styles.roundIconBtn} onPress={() => openSheet(setAttachMenuOpen)} accessibilityLabel="Add to chat">
                <Ionicons name="add" size={22} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.modelChip} onPress={() => openSheet(setModelSheetOpen)} accessibilityLabel="Model and effort">
                <Text style={styles.modelChipText} numberOfLines={1}>
                  {modelLabel} <Text style={styles.modelChipEffort}>{effort?.label ?? "Medium"}</Text>
                </Text>
              </TouchableOpacity>
              <View style={styles.flex1} />
              {sendButton}
            </View>
          )}
        </View>
      </View>

      {/* Attach sheet */}
      <Sheet visible={attachMenuOpen} onClose={() => setAttachMenuOpen(false)} title="Add to chat" colors={colors}>
        <View style={styles.sheetBody}>
          <View style={styles.attachTileRow}>
            <TouchableOpacity style={styles.attachTile} onPress={attachPhoto}>
              <View style={styles.attachTileIcon}>
                <Ionicons name="images-outline" size={22} color={colors.text} />
              </View>
              <Text style={styles.attachTileLabel}>Photos</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachTile} onPress={attachDocument}>
              <View style={styles.attachTileIcon}>
                <Ionicons name="document-attach-outline" size={22} color={colors.text} />
              </View>
              <Text style={styles.attachTileLabel}>Files</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={styles.sheetCardRow}
            onPress={() => {
              setAttachMenuOpen(false);
              setModeSheetOpen(true);
            }}
          >
            <View style={styles.sheetCardIcon}>
              <Ionicons name="shield-checkmark-outline" size={20} color={colors.text} />
            </View>
            <View style={styles.flex1}>
              <Text style={styles.sheetCardLabel}>Permissions</Text>
              <Text style={styles.sheetCardSub}>{mode?.label ?? "Manual"}</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.faint} />
          </TouchableOpacity>
        </View>
      </Sheet>

      <PickerSheet
        visible={modelSheetOpen}
        onClose={() => setModelSheetOpen(false)}
        title="Select model"
        options={[
          ...capabilities.models.map((m) => {
            const { title, subtitle } = modelMenuLabel(m);
            return { key: m.value, label: title, description: subtitle };
          }),
        ]}
        selectedKey={model}
        onSelect={setModel}
        colors={colors}
        styles={styles}
        footer={
          <>
            {/* Effort goes with the model, as in the Claude app. */}
            <TouchableOpacity
              style={styles.sheetCardRow}
              onPress={() => {
                setModelSheetOpen(false);
                setEffortSheetOpen(true);
              }}
            >
              <Text style={styles.sheetCardLabel}>Effort</Text>
              <Text style={styles.sheetCardValue}>{effort?.label ?? "Medium"}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.faint} />
            </TouchableOpacity>
          </>
        }
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

      <SessionToolsSheet
        visible={toolsOpen}
        onClose={() => setToolsOpen(false)}
        onExport={() => {
          setToolsOpen(false);
          setExportOpen(true);
        }}
        onAgents={() => {
          setToolsOpen(false);
          setAgentsOpen(true);
        }}
        sessionId={sessionId}
        context={conv.context}
        hasFiles={hasFiles}
        hasTree={hasTree}
        chatTitle={title || repoName || "This chat"}
        statusLine={
          loading
            ? "Loading…"
            : `${status}${isController ? "" : conv.controller ? ` · ${conv.controllerName ?? "Another device"} has control` : ""}`
        }
        statusColor={statusColor[status] ?? colors.faint}
        syncRows={syncRows.map(({ key, icon, label, action }) => ({ key, icon, label, action }))}
        onSync={(key) => {
          const row = syncRows.find((r) => r.key === key);
          if (!row) return;
          setToolsOpen(false);
          takeOver();
          realtime.submitPrompt(sessionId, row.prompt, promptOptsFor(conv.composer));
        }}
        running={background.length}
      />
      <ExportSheet sessionId={sessionId} title={title || repoName || "This chat"} visible={exportOpen} onClose={() => setExportOpen(false)} colors={colors} />

      <ImageViewer images={preview?.images ?? []} index={preview?.index ?? null} onClose={() => setPreview(null)} />
      <FileSheet sessionId={sessionId} file={openFile} onClose={() => setOpenFile(null)} />
      <AgentsSheet
        visible={agentsOpen}
        onClose={() => setAgentsOpen(false)}
        agents={agents}
        commands={commands}
        onShowInTranscript={(id) => {
          setAgentsOpen(false);
          revealTool(id);
        }}
      />
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
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  options: { key: string; label: string; description?: string }[];
  selectedKey: string;
  onSelect: (key: string) => void;
  colors: ThemeColors;
  styles: Styles;
  /** Shown under the options, inside the scroll (the model sheet's "enter an ID" field). */
  footer?: ReactNode;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title} colors={colors}>
      <ScrollView contentContainerStyle={styles.pickerList} keyboardShouldPersistTaps="handled">
        {/* One grouped card, rows split by hairlines, the pick marked by a tick alone: the Claude app's picker. */}
        <View style={styles.pickerGroup}>
          {options.map((o, i) => {
            const selected = o.key === selectedKey;
            return (
              <TouchableOpacity
                key={o.key}
                style={[styles.pickerRow, i > 0 && styles.pickerRowDivided]}
                onPress={() => {
                  onSelect(o.key);
                  onClose();
                }}
              >
                <View style={styles.flex1}>
                  <Text style={styles.pickerRowLabel}>{o.label}</Text>
                  {o.description && <Text style={styles.pickerRowDesc}>{o.description}</Text>}
                </View>
                {selected && <Ionicons name="checkmark" size={21} color={colors.accent} />}
              </TouchableOpacity>
            );
          })}
        </View>
        {footer}
      </ScrollView>
    </Sheet>
  );
}

/** One attached file: a thumbnail for images, a file chip otherwise. `onRemove` omitted renders it read-only (timeline history). */
/** Lines a message of yours shows before it folds, as on the web. */
const PROMPT_LINES = 14;

/**
 * Your message's text, folded to PROMPT_LINES when it's long, with a toggle,
 * like the web's. "Long" is estimated from its length (a phone line holds
 * about 40 characters), since React Native can't tell how many lines a folded
 * text would have had. Opened from search, it shows in full.
 */
function PromptText({ text, anchor, styles }: { text: string; anchor: string; styles: Styles }) {
  const [open, setOpen] = useState(false);
  const flash = useContext(SearchFlashContext);
  const long = text.split("\n").length > PROMPT_LINES || text.length > PROMPT_LINES * 40;
  const folded = long && !open && flash?.anchor !== anchor;
  return (
    <>
      <SearchMatchText text={text} anchor={anchor} style={styles.promptText} numberOfLines={folded ? PROMPT_LINES : undefined} />
      {long && (
        <TouchableOpacity onPress={() => setOpen((o) => !o)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
          <Text style={styles.promptMore}>{open ? "Show less" : "Show full message"}</Text>
        </TouchableOpacity>
      )}
    </>
  );
}

/** A file going by reference: uploading (no ref yet), uploaded (ref), or failed (error). */
type PendingUpload = { id: string; name: string; size: number; progress: number; ref?: UploadRef; error?: string };

/** A file sent by reference: its name and size, and while it uploads, how far it's got. */
function UploadChip({ upload, colors, styles, onRemove }: { upload: PendingUpload; colors: ThemeColors; styles: Styles; onRemove?: () => void }) {
  const pending = !upload.ref && !upload.error;
  return (
    <View style={[styles.attachChip, upload.error ? { borderColor: colors.danger } : null, { overflow: "hidden" }]}>
      {pending && (
        <View
          pointerEvents="none"
          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round(upload.progress * 100)}%`, backgroundColor: colors.accent, opacity: 0.15 }}
        />
      )}
      <Ionicons name={upload.error ? "warning-outline" : "document-outline"} size={14} color={upload.error ? colors.danger : colors.faint} />
      <Text style={styles.attachName} numberOfLines={1}>
        {upload.name}
      </Text>
      <Text style={{ color: colors.faint, fontSize: 11, fontVariant: ["tabular-nums"] }}>
        {upload.error ? "failed" : pending ? `${Math.round(upload.progress * 100)}%` : formatBytes(upload.size)}
      </Text>
      {onRemove && (
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
          <Ionicons name="close" size={14} color={colors.faint} />
        </TouchableOpacity>
      )}
    </View>
  );
}

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

/** What a tapped chip opens: the viewer over the images of the message it's in, starting at it. */
type OpenPreview = (images: Attachment[], index: number) => void;

function previewAmong(list: Attachment[], a: Attachment, open: OpenPreview) {
  const images = list.filter((x) => x.mediaType.startsWith("image/"));
  open(images, Math.max(0, images.indexOf(a)));
}

/**
 * Images a tool handed back to Claude (a screenshot it took, a PNG it Read),
 * shown under the step outside its fold so progress is visible at a glance.
 */
function ToolImages({ images, styles }: { images: AttachmentView[]; styles: Styles }) {
  const [previewing, setPreviewing] = useState<number | null>(null);
  if (images.length === 0) return null;
  const thumbs = images.map((img, i) => <ToolImageThumb key={i} image={img} styles={styles} onPress={() => setPreviewing(i)} />);
  return (
    <>
      {images.length === 1 ? (
        <View style={styles.toolImageRow}>{thumbs}</View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.toolImageRow}>
          {thumbs}
        </ScrollView>
      )}
      <ImageViewer images={images} index={previewing} onClose={() => setPreviewing(null)} />
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

type TimelineEntry = { item: TimelineItem; index: number };

/** The tool calls a "Show in transcript" opens: the target and every agent it's nested in. */
type RevealTarget = { ids: ReadonlySet<string> };
const RevealContext = createContext<RevealTarget | null>(null);

/** Tool-use ids from the outermost call in `blocks` down to `toolUseId`, or null when it isn't in there. */
function pathToTool(blocks: BlockView[], toolUseId: string): string[] | null {
  for (const b of blocks) {
    if (b?.kind !== "tool_use") continue;
    if (b.toolUseId === toolUseId) return [b.toolUseId];
    const inner = b.subagent ? pathToTool(b.subagent.blocks, toolUseId) : null;
    if (inner) return [b.toolUseId, ...inner];
  }
  return null;
}

/**
 * The row a search anchor sits in, and what to mark there: the prompt, the
 * reply block when it's shown on its own, otherwise its whole turn (a block
 * folded into a group of steps, as the web falls back to the turn).
 */
function findSearchAnchor(entries: TimelineEntry[], anchor: string): { index: number; anchor: string } | null {
  if (anchor.startsWith("p:")) {
    const id = anchor.slice(2);
    const index = entries.findIndex(
      ({ item }) => (item.type === "prompt" && item.promptId === id) || (item.type === "turn" && item.turn.steeredPrompts.some((p) => p.promptId === id)),
    );
    return index === -1 ? null : { index, anchor };
  }
  if (!anchor.startsWith("b:")) return null;
  const turnId = anchor.slice(2, anchor.lastIndexOf(":"));
  const blockIndex = Number(anchor.slice(anchor.lastIndexOf(":") + 1));
  const index = entries.findIndex(({ item }) => item.type === "turn" && item.turn.turnId === turnId);
  const item = entries[index]?.item;
  if (!item || item.type !== "turn") return null;
  const own = groupTurnBlocks(item.turn.blocks, new Set(item.turn.steeredPrompts.map((p) => p.afterBlockIndex))).some(
    (seg) => seg.kind !== "group" && seg.index === blockIndex && seg.block.kind === "text",
  );
  return { index, anchor: own ? anchor : `t:${turnId}` };
}

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
 * Nothing to see — it's there so maintainVisibleContentPosition always has a
 * view past the newest row to anchor on, even when that row is the only one.
 */
/** One-tap answers to the question the newest reply ended on (its suggest_replies call): a tap sends the label as your next message. */
function SuggestedReplies({
  question,
  replies,
  onPick,
  onDismiss,
  colors,
  styles,
}: {
  question: string | null;
  replies: string[];
  onPick: (text: string) => void;
  onDismiss: () => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  return (
    <FadeIn>
      <View style={styles.repliesWrap}>
        <View style={styles.repliesHead}>
          <Text style={[styles.toolStepLabel, styles.repliesQuestion]}>{question ?? ""}</Text>
          <TouchableOpacity onPress={onDismiss} hitSlop={10} accessibilityLabel="Close">
            <Ionicons name="close" size={16} color={colors.faint} />
          </TouchableOpacity>
        </View>
        <View style={styles.repliesRow}>
          {replies.map((r, i) => (
            <TouchableOpacity key={r} style={i === 0 ? styles.resumeNowBtn : styles.replyPill} onPress={() => onPick(r)}>
              <Text style={i === 0 ? styles.resumeNowText : styles.replyText}>{r}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </FadeIn>
  );
}

function TimelineAnchor() {
  return null;
}

function OlderLoading({ styles, colors }: { styles: Styles; colors: ThemeColors }) {
  return (
    <View style={styles.olderLoading}>
      <ActivityIndicator size="small" color={colors.faint} />
      <Text style={styles.meta}>Loading earlier messages</Text>
    </View>
  );
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
  afterNotice = false,
}: {
  item: TimelineItem;
  colors: ThemeColors;
  styles: Styles;
  onPreview: OpenPreview;
  /** Arrived since the chat opened: ease in rather than pop. */
  animate?: boolean;
  /** A notice right after another: pulled up so back-to-back notices ("limit hit", "switched account") read as one block. */
  afterNotice?: boolean;
}) {
  return (
    <FadeIn enabled={animate} style={afterNotice ? { marginTop: -10 } : undefined}>
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
  onPreview: OpenPreview;
}) {
  if (item.type === "prompt") {
    return (
      <LongPressToRead title="Your message" text={item.text} style={styles.promptWrap}>
        {item.text.length > 0 && <PromptText text={item.text} anchor={`p:${item.promptId}`} styles={styles} />}
        {item.attachments && item.attachments.length > 0 && (
          <View style={styles.attachRow}>
            {item.attachments.map((a, i) => (
              <AttachmentChip key={i} attachment={a} colors={colors} styles={styles} onPreview={(a) => previewAmong(item.attachments!, a, onPreview)} />
            ))}
          </View>
        )}
        {item.uploads && item.uploads.length > 0 && (
          <View style={styles.attachRow}>
            {item.uploads.map((u) => (
              <UploadChip key={u.id} upload={{ id: u.id, name: u.name, size: u.size, progress: 1, ref: u }} colors={colors} styles={styles} />
            ))}
          </View>
        )}
        <SearchFlash anchor={`p:${item.promptId}`} inset={0} rounding={radius.lg} />
      </LongPressToRead>
    );
  }
  if (item.type === "notice") {
    // A quiet annotation in the reply column, not a centred capsule; only the icon carries the colour.
    return (
      <View style={styles.noticeRow}>
        <Ionicons
          name={item.level === "warn" ? "warning-outline" : "information-circle-outline"}
          size={14}
          color={item.level === "warn" ? colors.busy : colors.dim}
          style={styles.noticeIcon}
        />
        <Text style={styles.notice}>{item.text}</Text>
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
    return <BackgroundTasksRow tasks={item.tasks} colors={colors} styles={styles} />;
  }
  return <AssistantTurn turn={item.turn} colors={colors} styles={styles} onPreview={onPreview} />;
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
  colors,
  styles,
}: {
  tasks: { summary: string; status: "completed" | "failed" | "stopped" }[];
  colors: ThemeColors;
  styles: Styles;
}) {
  const [open, setOpen] = useState(false);
  const failed = tasks.filter((t) => t.status === "failed").length;
  const label =
    tasks.length === 1
      ? `Background task finished: ${tasks[0]!.summary}`
      : `${tasks.length} background tasks finished${failed > 0 ? ` · ${failed} failed` : ""}${open ? "" : " ›"}`;
  return (
    <View>
      <TouchableOpacity
        disabled={tasks.length === 1}
        onPress={() => {
          animateLayout();
          setOpen((o) => !o);
        }}
        style={styles.noticeRow}
      >
        <Ionicons name="layers-outline" size={14} color={failed > 0 ? colors.busy : colors.dim} style={styles.noticeIcon} />
        <Text style={styles.notice}>{label}</Text>
      </TouchableOpacity>
      {open && (
        <View style={styles.noticeList}>
          {tasks.map((t, i) => (
            <View key={i} style={styles.noticeRow}>
              <Ionicons
                name={t.status === "completed" ? "checkmark-circle-outline" : t.status === "stopped" ? "stop-circle-outline" : "close-circle-outline"}
                size={14}
                color={t.status === "completed" ? colors.ok : t.status === "stopped" ? colors.dim : colors.danger}
                style={styles.noticeIcon}
              />
              <Text style={styles.notice}>{t.summary}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function AssistantTurn({
  turn,
  colors,
  styles,
  onPreview,
}: {
  turn: TurnView;
  colors: ThemeColors;
  styles: Styles;
  onPreview: OpenPreview;
}) {
  const label = turnTriggerLabel(turn);
  const steeredAfter = (index: number) => turn.steeredPrompts.filter((p) => p.afterBlockIndex === index);
  const todos = turnTodos(turn);
  return (
    <View style={styles.turn}>
      {label && <Text style={styles.meta}>{label}</Text>}
      {steeredAfter(-1).map((p) => (
        <SteeredPrompt key={p.promptId} prompt={p} colors={colors} styles={styles} onPreview={onPreview} waiting={turn.status === "running" && turn.blocks.length - 1 <= p.afterBlockIndex} />
      ))}
      {groupTurnBlocks(turn.blocks, new Set(turn.steeredPrompts.map((p) => p.afterBlockIndex))).map((seg) => {
        const last = seg.kind === "group" ? seg.items[seg.items.length - 1]!.index : seg.index;
        return (
          <Fragment key={seg.kind === "group" ? `g${seg.items[0]!.index}` : seg.index}>
            {seg.kind === "group" ? (
              <ToolGroup items={seg.items} summary={seg.summary} colors={colors} styles={styles} turnRunning={turn.status === "running"} />
            ) : (
              <Block block={seg.block} colors={colors} styles={styles} turnRunning={turn.status === "running"} anchor={`b:${turn.turnId}:${seg.index}`} />
            )}
            <ToolImages images={segmentImages(seg)} styles={styles} />
            {steeredAfter(last).map((p) => (
              <SteeredPrompt key={p.promptId} prompt={p} colors={colors} styles={styles} onPreview={onPreview} waiting={turn.status === "running" && turn.blocks.length - 1 <= p.afterBlockIndex} />
            ))}
          </Fragment>
        );
      })}
      {todos && <TurnTasks todos={todos} running={turn.status === "running"} colors={colors} styles={styles} />}
      {turn.status !== "running" && <FilesChanged changes={turnFileChanges(turn)} colors={colors} styles={styles} />}
      {turn.status === "running" && <TurnStatus turn={turn} colors={colors} styles={styles} />}
      {turn.status === "done" && <TurnFooter turn={turn} colors={colors} styles={styles} />}
      {turn.status === "error" &&
        (turn.interrupted ? (
          <Text style={styles.meta}>Stopped</Text>
        ) : (
          <LongPressToRead title="Error" text={`Turn failed: ${turn.errorMessage}`}>
            <View style={styles.noticeRow}>
              <Ionicons name="close-circle-outline" size={14} color={colors.danger} style={styles.noticeIcon} />
              <Text style={styles.notice}>
                <Text style={styles.noticeStrong}>Turn failed.</Text> {turn.errorMessage}
              </Text>
            </View>
          </LongPressToRead>
        ))}
      <SearchFlash anchor={`t:${turn.turnId}`} />
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
  // A "Show in transcript" for a call folded in here opens the group.
  const reveal = useContext(RevealContext);
  useEffect(() => {
    if (reveal && items.some((it) => it.block.kind === "tool_use" && reveal.ids.has(it.block.toolUseId))) setOpen(true);
    // Only when a reveal arrives (or this row mounts during one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);
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
/** "Send now" for a message sent mid-turn (see SteeredPrompt). */
const SendNowContext = createContext<(() => void) | null>(null);

/**
 * `waiting`: the turn is running and Claude hasn't written anything since this
 * message arrived, so it's probably waiting behind a long step: offer "Send
 * now", which moves that step to the background so Claude reads it now.
 */
function SteeredPrompt({
  prompt,
  colors,
  styles,
  onPreview,
  waiting = false,
}: {
  prompt: SteeredPromptView;
  colors: ThemeColors;
  styles: Styles;
  onPreview: OpenPreview;
  waiting?: boolean;
}) {
  const sendNow = useContext(SendNowContext);
  const [sent, setSent] = useState(false);
  return (
    <LongPressToRead title="Your message" text={prompt.text} style={[styles.promptWrap, styles.steeredWrap]}>
      {prompt.text.length > 0 && <PromptText text={prompt.text} anchor={`p:${prompt.promptId}`} styles={styles} />}
      {prompt.attachments && prompt.attachments.length > 0 && (
        <View style={styles.attachRow}>
          {prompt.attachments.map((a, i) => (
            <AttachmentChip key={i} attachment={a} colors={colors} styles={styles} onPreview={(a) => previewAmong(prompt.attachments!, a, onPreview)} />
          ))}
        </View>
      )}
      {prompt.uploads && prompt.uploads.length > 0 && (
        <View style={styles.attachRow}>
          {prompt.uploads.map((u) => (
            <UploadChip key={u.id} upload={{ id: u.id, name: u.name, size: u.size, progress: 1, ref: u }} colors={colors} styles={styles} />
          ))}
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={styles.meta}>Sent while Claude was working</Text>
        {/* Once tapped it's gone at once, the message counted as sent: Claude reads it within moments. */}
        {waiting && sendNow && !sent && (
          <TouchableOpacity
            onPress={() => {
              setSent(true);
              sendNow();
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.promptMore, { marginTop: 0, color: colors.accent }]}>Send now</Text>
          </TouchableOpacity>
        )}
      </View>
      <SearchFlash anchor={`p:${prompt.promptId}`} inset={0} rounding={radius.lg} />
    </LongPressToRead>
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
  anchor,
}: {
  block: BlockView;
  colors: ThemeColors;
  styles: Styles;
  turnRunning: boolean;
  /** `b:<turnId>:<index>` for a reply's own block, so a search hit on it can mark it. */
  anchor?: string;
}) {
  if (block.kind === "tool_use") {
    return <ToolStep block={block} colors={colors} styles={styles} turnRunning={turnRunning} />;
  }
  if (block.kind === "thinking") {
    return <ThinkingBlock block={block} live={turnRunning && block.endedAtMs == null} colors={colors} styles={styles} />;
  }
  return (
    <LongPressToRead title="Claude's reply" text={block.text} markdown>
      <StreamingMarkdown content={block.text} streaming={turnRunning && block.endedAtMs == null} />
      {anchor && <SearchFlash anchor={anchor} />}
    </LongPressToRead>
  );
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
  // Likewise a Mac build: its call returns at once, and the build reports on
  // until it ends — maybe after the turn has.
  const build = block.macBuild;
  // A task list isn't opened unprompted: the turn shows its latest state at its foot.
  const richPayload = editView != null || plan != null || block.subagent != null;
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
  // "Show in transcript" opens this row when it's the call or an agent on the way to it, and keeps it open.
  const reveal = useContext(RevealContext);
  const revealed = !!reveal && reveal.ids.has(block.toolUseId);
  useEffect(() => {
    if (!revealed) return;
    userToggled.current = true;
    setOpen(true);
  }, [revealed]);

  // One glyph language for every step: check = finished, cross = failed,
  // spinner-ish dot = still going, square = stopped.
  const outcome: { icon: keyof typeof Ionicons.glyphMap; color: string } | null = build
    ? build.state === "running"
      ? { icon: "ellipsis-horizontal", color: colors.faint }
      : build.state === "succeeded"
        ? { icon: "checkmark", color: colors.ok }
        : { icon: "close", color: colors.danger }
    : block.backgroundTask
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
        <SearchFlash anchor={`u:${block.toolUseId}`} inset={-4} rounding={radius.xs} />
      </TouchableOpacity>
      {build && <MacBuildStatus build={build} styles={styles} />}
      {open && (
        <View style={styles.toolStepBody}>
          {editView ? (
            <DiffView view={editView} colors={colors} styles={styles} />
          ) : todos ? (
            <TodoChecklist todos={todos} colors={colors} styles={styles} />
          ) : plan ? (
            <Markdown content={plan} />
          ) : (
            // A shell command reads as the command, anything else as indented JSON; as long as the web shows.
            <Text style={styles.toolBody}>
              {typeof (block.toolInput as { command?: unknown } | null)?.command === "string"
                ? `$ ${truncate((block.toolInput as { command: string }).command, 800)}`
                : truncate(JSON.stringify(block.toolInput, null, 2), 800)}
            </Text>
          )}
          {block.result && (
            <Text style={[styles.toolBody, !block.result.ok && styles.errText]}>
              {block.result.ok ? "" : "error: "}
              {truncate(block.result.summary, 800)}
            </Text>
          )}
          {block.subagent && <SubagentActivity subagent={block.subagent} revealed={revealed} colors={colors} styles={styles} />}
          {block.backgroundTask && (
            <Text style={styles.toolBody}>
              {truncate(block.backgroundTask.summary, 800)}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

/**
 * A Mac build's progress under its call, folded or not: the phase with a
 * ticking m:ss while it runs, then how it ended and how long it took. The
 * detail is the build's latest log line, then the first line of its result.
 */
function MacBuildStatus({ build, styles }: { build: MacBuildView; styles: Styles }) {
  const live = build.state === "running";
  const elapsedSeconds = useElapsedSeconds(live ? build.startedAt : null);
  const time =
    elapsedSeconds != null
      ? `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`
      : build.endedAt != null
        ? formatTurnDuration(build.endedAt - build.startedAt)
        : null;
  return (
    <View style={styles.macBuild}>
      <Text style={[styles.macBuildPhase, build.state === "failed" && styles.errText]} numberOfLines={1}>
        {build.phase}
        {time && <Text style={styles.macBuildTime}> · {time}</Text>}
      </Text>
      {build.detail && (
        <Text style={styles.toolBody} numberOfLines={1} ellipsizeMode="tail">
          {build.detail}
        </Text>
      )}
    </View>
  );
}

/** A Task call's own nested activity, live-streamed via the Agent SDK's forwardSubagentText — collapsible, open by default while running, auto-collapses once done. Mirrors web's <details>-based SubagentActivity. */
function SubagentActivity({
  subagent,
  revealed,
  colors,
  styles,
}: {
  subagent: SubagentView;
  /** Its agent's row is on a "Show in transcript" path: open its feed too. */
  revealed: boolean;
  colors: ThemeColors;
  styles: Styles;
}) {
  const [expanded, setExpanded] = useState(subagent.status === "running" || revealed);
  useEffect(() => {
    if (revealed) setExpanded(true);
  }, [revealed]);
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
/** "3h ago", kept current by its own once-a-minute tick rather than only when the chat redraws. */
function Ago({ at, styles }: { at: number; styles: Styles }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  return <Text style={styles.meta}>· {formatAgo(at)}</Text>;
}

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
        {/* Roughly when: enough to place a reply in a long-running chat. */}
        {turn.endedAt != null && <Ago at={turn.endedAt} styles={styles} />}
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

/**
 * Under an approval this device can't answer yet: who can, and the one tap
 * that makes it this device. The card above stays as the controller sees it,
 * buttons disabled, so it reads as the same decision.
 */
function NotInControl({ name, onTakeControl, styles }: { name: string | null; onTakeControl: () => void; styles: Styles }) {
  return (
    <View style={styles.permNotInControl}>
      <Text style={[styles.permBody, { flexShrink: 1 }]}>{name ? `${name} has control, so only it can answer.` : "Another device has control."}</Text>
      <TouchableOpacity style={styles.ctrlBtn} onPress={onTakeControl}>
        <Text style={styles.ctrlBtnText}>Take control</Text>
      </TouchableOpacity>
    </View>
  );
}

function PermissionCard({
  perm,
  canAct,
  controllerName,
  onTakeControl,
  onDecide,
  colors,
  styles,
}: {
  perm: PermissionView;
  canAct: boolean;
  controllerName: string | null;
  onTakeControl: () => void;
  onDecide: (d: "allow" | "deny", updatedInput?: Record<string, unknown>) => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  // Answered here, waiting for the daemon to take the card away: the buttons
  // stay put meanwhile, and a second tap used to send a second answer.
  const [decided, setDecided] = useState<"allow" | "deny" | null>(null);
  const decide = (d: "allow" | "deny", updatedInput?: Record<string, unknown>) => {
    setDecided(d);
    onDecide(d, updatedInput);
  };
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
        decided={decided}
        controllerName={controllerName}
        onTakeControl={onTakeControl}
        onSubmit={(answers) => decide("allow", { ...(perm.toolInput as Record<string, unknown>), answers })}
        onCancel={() => decide("deny")}
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
      {perm.reason ? <Text style={styles.permReason}>{perm.reason}</Text> : null}
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
      <View style={[styles.permActions, !canAct && { opacity: 0.4 }]}>
        <TouchableOpacity
          style={[styles.allowBtn, styles.permBtnRow, decided === "deny" && styles.disabled]}
          disabled={!canAct || decided !== null}
          onPress={() => decide("allow")}
        >
          {decided === "allow" && <ActivityIndicator size="small" color={colors.accentFg} />}
          <Text style={styles.allowText}>
            {decided === "allow" ? (plan != null ? "Approving…" : "Allowing…") : plan != null ? "Approve plan" : "Allow"}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.denyBtn, styles.permBtnRow, decided === "allow" && styles.disabled]}
          disabled={!canAct || decided !== null}
          onPress={() => decide("deny")}
        >
          {decided === "deny" && <ActivityIndicator size="small" color={colors.danger} />}
          <Text style={styles.denyText}>
            {decided === "deny" ? (plan != null ? "Sending…" : "Denying…") : plan != null ? "Keep planning" : "Deny"}
          </Text>
        </TouchableOpacity>
      </View>
      {!canAct && <NotInControl name={controllerName} onTakeControl={onTakeControl} styles={styles} />}
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
  decided,
  controllerName,
  onTakeControl,
  onSubmit,
  onCancel,
  colors,
  styles,
}: {
  view: AskUserQuestionView;
  canAct: boolean;
  /** Answered or cancelled here, not yet cleared by the daemon. */
  decided: "allow" | "deny" | null;
  controllerName: string | null;
  onTakeControl: () => void;
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
      <View style={[styles.permActions, !canAct && { opacity: 0.4 }]}>
        <TouchableOpacity
          style={[styles.allowBtn, styles.permBtnRow, ((canAct && !allAnswered) || decided === "deny") && { opacity: 0.4 }]}
          disabled={!canAct || !allAnswered || decided !== null}
          onPress={handleSubmit}
        >
          {decided === "allow" && <ActivityIndicator size="small" color={colors.accentFg} />}
          <Text style={styles.allowText}>{decided === "allow" ? "Sending…" : "Submit answers"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.denyBtn, styles.permBtnRow, decided === "allow" && styles.disabled]}
          disabled={!canAct || decided !== null}
          onPress={onCancel}
        >
          {decided === "deny" && <ActivityIndicator size="small" color={colors.danger} />}
          <Text style={styles.denyText}>{decided === "deny" ? "Cancelling…" : "Cancel"}</Text>
        </TouchableOpacity>
      </View>
      {!canAct && <NotInControl name={controllerName} onTakeControl={onTakeControl} styles={styles} />}
    </View>
  );
}

/** Caps how many diff lines render before collapsing the rest into a note — a full-file Write can be thousands of lines. */
const MAX_DIFF_LINES_SHOWN = 400;

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

/**
 * The turn's task list, once, as Claude last wrote it — ticking off in place
 * instead of repeating with every update. Open while the turn runs, so where
 * it stands shows without scrolling; folds to its count once it's done.
 */
function TurnTasks({ todos, running, colors, styles }: { todos: TodoItemView[]; running: boolean; colors: ThemeColors; styles: Styles }) {
  const [open, setOpen] = useState(running);
  const userToggled = useRef(false);
  useEffect(() => {
    if (!userToggled.current) setOpen(running);
  }, [running]);
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <View style={styles.filesCard}>
      <TouchableOpacity
        style={styles.toolStepHeader}
        activeOpacity={0.7}
        onPress={() => {
          userToggled.current = true;
          animateLayout();
          setOpen((o) => !o);
        }}
      >
        <Ionicons name="checkbox-outline" size={13} color={colors.faint} />
        <Text style={[styles.toolStepLabel, { flex: 1 }]} numberOfLines={1}>
          Tasks · {done} of {todos.length} done
        </Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={12} color={colors.faint} />
      </TouchableOpacity>
      {open && (
        <View style={{ paddingBottom: 6 }}>
          <TodoChecklist todos={todos} colors={colors} styles={styles} />
        </View>
      )}
    </View>
  );
}

/** The running turn's last line: the task in progress, or just "Working", and how long the turn has run. */
function TurnStatus({ turn, colors, styles }: { turn: TurnView; colors: ThemeColors; styles: Styles }) {
  const elapsed = useElapsedSeconds(turn.startedAt);
  return (
    <View style={styles.turnStatus}>
      <ActivityIndicator size="small" color={colors.faint} />
      <Text style={[styles.meta, { flexShrink: 1 }]} numberOfLines={1}>
        {turnActivity(turn) ?? "Working"}
      </Text>
      {elapsed != null && <Text style={styles.meta}>{formatTurnDuration(elapsed * 1000)}</Text>}
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
    headerTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
    headerSub: { color: colors.faint, fontSize: 11, marginTop: 1 },
    menuBtn: { padding: 4 },
    menuBadge: { position: "absolute", top: 0, right: 0 },
    menuBadgeDot: { width: 7, height: 7, borderRadius: 4 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    ctrlBtn: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
    ctrlBtnText: { color: colors.accentFg, fontSize: 13, fontWeight: "700" },
    timelineWrap: { flex: 1 },
    olderLoading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 12 },
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
    noticeRow: { flexDirection: "row", alignItems: "flex-start", gap: 7 },
    noticeIcon: { marginTop: 1.5 },
    notice: { flex: 1, color: colors.dim, fontSize: 12, lineHeight: 17 },
    noticeStrong: { color: colors.text, fontWeight: "600" },
    noticeList: { marginTop: 6, marginLeft: 6, paddingLeft: 14, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border, gap: 4 },
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
    promptMore: { color: colors.dim, fontSize: 13, fontWeight: "600", marginTop: 6 },
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
      maxWidth: 240,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
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
    // flexShrink, not flex: 1: the chip sizes to its content, so a flex-basis of 0 squeezed the name to nothing.
    attachName: { flexShrink: 1, color: colors.text, fontSize: 12 },
    attachError: { color: colors.danger, fontSize: 12, paddingHorizontal: 16, paddingTop: 4 },
    pickerList: { paddingHorizontal: 14, gap: 8, paddingBottom: 8 },
    pickerGroup: { borderRadius: radius.lg, backgroundColor: colors.inset, overflow: "hidden" },
    pickerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    pickerRowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    pickerRowLabel: { color: colors.text, fontSize: 16 },
    pickerRowDesc: { color: colors.dim, fontSize: 13, marginTop: 2 },
    sheetBody: { paddingHorizontal: 14, paddingBottom: 16, gap: 10 },
    attachTileRow: { flexDirection: "row", gap: 10 },
    attachTile: { flex: 1, alignItems: "center", gap: 10, backgroundColor: colors.inset, borderRadius: radius.lg, paddingVertical: 18 },
    attachTileIcon: {
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor: colors.panel,
      alignItems: "center",
      justifyContent: "center",
    },
    attachTileLabel: { color: colors.text, fontSize: 15 },
    sheetCardRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.inset, borderRadius: radius.lg, paddingHorizontal: 16, paddingVertical: 14 },
    sheetCardIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.panel, alignItems: "center", justifyContent: "center" },
    sheetCardLabel: { color: colors.text, fontSize: 16, flexShrink: 1 },
    sheetCardSub: { color: colors.dim, fontSize: 13, marginTop: 2 },
    sheetCardValue: { flex: 1, textAlign: "right", color: colors.dim, fontSize: 15 },
    turn: { gap: 10 },
    thinkingWrap: { backgroundColor: withAlpha(colors.faint, 0.1), borderRadius: radius.md, padding: 12, gap: 4 },
    thinkingHeader: { color: colors.faint, fontSize: 11 },
    turnStatus: { flexDirection: "row", alignItems: "center", gap: 6 },
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
    macBuild: { gap: 2, paddingBottom: 6, paddingLeft: 20 },
    macBuildPhase: { color: colors.dim, fontSize: 12 },
    macBuildTime: { color: colors.faint, fontVariant: ["tabular-nums"] },
    subagentWrap: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 6, paddingTop: 8, gap: 8 },
    subagentHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
    subagentType: { color: colors.text, fontSize: 12, fontWeight: "700" },
    subagentDesc: { flex: 1, color: colors.faint, fontSize: 12 },
    subagentBody: { gap: 8, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: colors.border },
    permCard: { backgroundColor: colors.inset, borderRadius: radius.lg, padding: 14, gap: 8 },
    permHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
    permTitle: { color: colors.busy, fontSize: 14, fontWeight: "600" },
    permBody: { color: colors.dim, fontSize: 12 },
    permReason: { color: colors.text, fontSize: 13, lineHeight: 18 },
    permDetailScroll: { maxHeight: 220, backgroundColor: colors.panel, borderRadius: radius.sm },
    permActions: { flexDirection: "row", gap: 10, marginTop: 4 },
    permNotInControl: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
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
    repliesWrap: { gap: 10, marginTop: 14, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
    repliesHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    repliesQuestion: { flex: 1, color: colors.text },
    repliesRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
    replyPill: { backgroundColor: colors.panel, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 6 },
    replyText: { color: colors.text, fontSize: 13, fontWeight: "600" },
    allowBtn: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 20, paddingVertical: 10 },
    allowText: { color: colors.accentFg, fontWeight: "700" },
    denyBtn: { backgroundColor: withAlpha(colors.danger, 0.14), borderRadius: radius.pill, paddingHorizontal: 20, paddingVertical: 10 },
    denyText: { color: colors.danger, fontWeight: "700" },
    /** Room for the spinner beside the label once a permission button is tapped. */
    permBtnRow: { flexDirection: "row", alignItems: "center", gap: 6 },
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
      flexDirection: "column",
      alignItems: "stretch",
      gap: 4,
      backgroundColor: colors.panel,
      borderRadius: radius.xl,
      paddingLeft: 4,
      paddingRight: 4,
      paddingVertical: 4,
      ...softShadow(colors),
    },
    composerPillOpen: { gap: 2, paddingTop: 6 },
    composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 4 },
    composerInputOpen: { paddingHorizontal: 12, minHeight: 44 },
    modelChip: { backgroundColor: withAlpha(colors.text, 0.07), borderRadius: radius.pill, paddingHorizontal: 14, height: 38, justifyContent: "center", maxWidth: 220 },
    modelChipText: { color: colors.text, fontSize: 14, fontWeight: "500" },
    modelChipEffort: { color: colors.dim, fontWeight: "400" },
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
