import {
  attachmentBytes,
  DEFAULT_EFFORT_KEY,
  EFFORT_LEVELS,
  filterRepoChoices,
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_PROMPT_ATTACHMENT_BYTES,
  modelFullName,
  modelMenuLabel,
  PERMISSION_MODES,
  pickableModel,
  repoChoices,
  resolveRepoChoice,
  type PermissionModeKey,
  type RepoChoice,
  attachmentSource,
  type Attachment,
} from "@renki/client-core";
import type { CapabilitiesResponse, GithubReposResponse, Repo, UploadRef } from "@renki/protocol";
import { Ionicons } from "@expo/vector-icons";
import { randomUUID } from "expo-crypto";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Image, Keyboard, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ImageViewer } from "../components/ImageViewer";
import { Sheet } from "../components/Sheet";
import { clearDraft, loadDraft, saveDraft } from "../lib/drafts";

/** The drafts key for a chat that doesn't exist yet. */
const NEW_CHAT_DRAFT = "new-chat";
import { pickDocumentAttachments, pickImageAttachments, type PendingAttachment, type Picked } from "../lib/attachments";
import { useClient, useStoreValue } from "../lib/client";
import { loadDeviceDefaults, rememberDeviceDefaults } from "../lib/composerPrefs";
import { matchesProject } from "../lib/newChatLink";
import { formatBytes, uploadFile } from "../lib/upload";
import { radius, softShadow, type ThemeColors, useTheme, withAlpha } from "../theme";

/** A big file going by reference (see UploadRef), streamed while you type. */
type PendingUpload = { id: string; name: string; size: number; progress: number; ref?: UploadRef; error?: string };

/**
 * Start a chat by just typing, like the web's home screen: a full screen with
 * the composer at the bottom, kept above the keyboard the same way the chat
 * screen's is. The session is created when the message is sent, as a
 * repo-less chat unless a repo is picked from the chip. Picking a repo swaps
 * the body for a searchable list in place (no Modal: a Modal with a text field
 * is what the keyboard used to cover). One the host hasn't checked out is
 * cloned first. Model, effort and permissions start at this device's defaults,
 * and a pick here becomes the new default.
 */
export function NewChatScreen({
  onBack,
  onStarted,
  initialRepoId = null,
  initialProject = null,
  initialPrompt = null,
}: {
  onBack: () => void;
  onStarted: (sessionId: string) => void;
  /** Preselects this host checkout (a repo group's "+" in the session list). */
  initialRepoId?: string | null;
  /** A project named by a /new link (see lib/newChatLink): a folder or GitHub name, not an id. */
  initialProject?: string | null;
  /** A /new link's prompt: filled in, never sent until the user presses send. */
  initialPrompt?: string | null;
}) {
  const colors = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const { rest, realtime, config } = useClient();
  const connection = useStoreValue(realtime.status);

  const [text, setText] = useState(initialPrompt ?? "");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  /** The photos open full screen, and which one is showing. */
  const [preview, setPreview] = useState<{ images: Attachment[]; index: number } | null>(null);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);

  // What's typed here is kept as a draft, like a chat's, so stepping away (a notification opening
  // another chat, the app being killed) doesn't lose it. A /new link's prompt wins over it.
  const draftLoaded = useRef(initialPrompt !== null);
  useEffect(() => {
    if (draftLoaded.current) return;
    let live = true;
    void loadDraft(NEW_CHAT_DRAFT).then((draft) => {
      draftLoaded.current = true;
      if (!live || !draft) return;
      setText((cur) => (cur ? cur : draft.text));
      setAttachments((prev) => (prev.length > 0 ? prev : draft.attachments.map((a) => ({ ...a, id: randomUUID() }))));
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!draftLoaded.current) return;
    const id = setTimeout(() => saveDraft(NEW_CHAT_DRAFT, text, attachments.map(({ id: _id, ...a }) => a)), 250);
    return () => clearTimeout(id);
  }, [text, attachments]);
  const uploadCancels = useRef(new Map<string, () => void>());
  const [repo, setRepo] = useState<RepoChoice | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [local, setLocal] = useState<Repo[] | null>(null);
  const [github, setGithub] = useState<GithubReposResponse | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [capabilities, setCapabilities] = useState<CapabilitiesResponse>({ models: [], commands: [] });
  const [model, setModel] = useState("");
  const [effortKey, setEffortKey] = useState<string>(DEFAULT_EFFORT_KEY);
  const [permissionMode, setPermissionMode] = useState<PermissionModeKey | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [effortSheetOpen, setEffortSheetOpen] = useState(false);
  const [modeSheetOpen, setModeSheetOpen] = useState(false);

  useEffect(() => {
    let live = true;
    rest
      .listRepos()
      .then((r) => live && setLocal(r))
      .catch(() => live && setLocal([]));
    rest
      .listGithubRepos()
      .then((g) => live && setGithub(g))
      .catch(() => live && setGithub({ available: false, reason: "Couldn't reach the daemon.", login: null, repos: [] }));
    Promise.all([loadDeviceDefaults(), rest.getCapabilities().catch((): CapabilitiesResponse => ({ models: [], commands: [] }))]).then(
      ([defaults, caps]) => {
        if (!live) return;
        setCapabilities(caps);
        setModel(pickableModel(defaults.model, caps.models));
        setEffortKey(defaults.effortKey);
        setPermissionMode(defaults.permissionMode);
      },
    );
    return () => {
      live = false;
      for (const cancel of uploadCancels.current.values()) cancel();
    };
  }, [rest]);

  const choices = useMemo(() => (local ? repoChoices(local, github?.available ? github.repos : null) : null), [local, github]);
  const matches = useMemo(() => filterRepoChoices(choices ?? [], query), [choices, query]);
  const typed = query.trim();
  const typedRef =
    /^[\w.-]+\/[\w.-]+$/.test(typed) && !(choices ?? []).some((c) => c.fullName?.toLowerCase() === typed.toLowerCase()) ? typed : null;

  // A repo asked for up front is picked from the local checkouts at once; when
  // GitHub's list comes, its row for the same repo replaces the local one,
  // unless something else has been picked since (as on the web).
  const preselected = useRef<string | null>(null);
  useEffect(() => {
    if (preselected.current === "done" || (!initialRepoId && !initialProject) || !choices) return;
    const match = choices.find((c) => (initialRepoId ? c.local?.id === initialRepoId : matchesProject(c, initialProject!)));
    const earlier = preselected.current;
    if (match) setRepo((cur) => (cur === null || cur.key === earlier ? match : cur));
    preselected.current = github ? "done" : (match?.key ?? null);
  }, [initialRepoId, initialProject, choices, github]);
  /** The asked-for repo isn't found yet: sending now would start a chat with no repo. */
  const findingRepo = Boolean(initialRepoId || initialProject) && repo === null && github === null;
  /** A link named a project this host and GitHub don't know: say so, rather than quietly starting without one. */
  const projectMissing =
    !!initialProject && repo === null && github !== null && choices !== null && !choices.some((c) => matchesProject(c, initialProject));

  // Android back steps out of the repo list first. Registered only while the
  // list shows, so it's the newest listener and runs before App's.
  useEffect(() => {
    if (!picking) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closePicker();
      return true;
    });
    return () => sub.remove();
  }, [picking]);

  const uploading = uploads.some((u) => !u.ref && !u.error);
  const hasContent = text.trim().length > 0 || attachments.length > 0 || uploads.length > 0;
  const canSend = connection === "open" && progress === null && !findingRepo && !uploading && hasContent;

  /** A send in flight, set before any await: a second tap (the button only disables a render later) is ignored. */
  const starting = useRef(false);
  /** The session made by a send that then failed: a retry reuses it rather than making another. */
  const created = useRef<{ id: string; composer: { model: string; effortKey: string; permissionMode: PermissionModeKey } } | null>(null);

  // While a chat is starting, back does nothing: leaving would still open the chat once it's made.
  useEffect(() => {
    if (progress === null) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, [progress]);

  async function start() {
    if (!canSend || starting.current) return;
    if (uploads.some((u) => u.error)) return setError("Remove the file that failed to upload, or try it again.");
    starting.current = true;
    setError(null);
    setProgress("Starting…");
    try {
      let session = created.current;
      if (!session) {
      let target: { repoId: string; baseBranch: string } | null = null;
      if (repo) {
        if (!repo.local) setProgress(`Cloning ${repo.fullName}…`);
        const r = await resolveRepoChoice(rest, repo);
        target = { repoId: r.id, baseBranch: r.defaultBranch };
      }
      setProgress(target ? "Getting the latest from GitHub…" : "Starting…");
      const defaults = await loadDeviceDefaults();
      const composer = {
        model: model || defaults.model,
        effortKey,
        permissionMode: permissionMode ?? defaults.permissionMode,
      };
      const made = await rest.createSession(target ? { ...target, composer } : { composer });
      session = created.current = { id: made.id, composer };
      }
      const { composer } = session;
      realtime.takeControl(session.id);
      const refs = uploads.map((u) => u.ref!);
      realtime.submitPrompt(session.id, text.trim(), {
        model: composer.model || undefined,
        maxThinkingTokens: EFFORT_LEVELS.find((e) => e.key === composer.effortKey)?.maxThinkingTokens ?? undefined,
        permissionMode: composer.permissionMode,
        attachments: attachments.length > 0 ? attachments.map(({ id: _id, ...a }) => a) : undefined,
        uploads: refs.length > 0 ? refs : undefined,
      });
      // Drop this screen's keyboard before the chat's composer mounts, or
      // Android's IME can stay attached to the input that's going away.
      Keyboard.dismiss();
      clearDraft(NEW_CHAT_DRAFT);
      onStarted(session.id);
    } catch (e) {
      starting.current = false;
      setProgress(null);
      setError(e instanceof Error ? e.message : "Couldn't start the session.");
    }
  }

  function openSheet(open: (v: boolean) => void) {
    Keyboard.dismiss();
    open(true);
  }

  function addPicked(results: Picked[]) {
    const errors = results.filter((r): r is { error: string } => "error" in r).map((r) => r.error);
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
    setError(errors[0] ?? null);
  }

  function startUpload(uri: string, name: string, size: number | undefined) {
    const id = randomUUID();
    setUploads((prev) => [...prev, { id, name, size: size ?? 0, progress: 0 }]);
    const { done, cancel } = uploadFile(uri, name, config, (p) => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, progress: p } : u))));
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

  async function attach(kind: "photo" | "file") {
    setAttachMenuOpen(false);
    const room = MAX_ATTACHMENTS_PER_PROMPT - attachments.length - uploads.length;
    if (room <= 0) return setError(`Up to ${MAX_ATTACHMENTS_PER_PROMPT} attachments per message.`);
    addPicked(await (kind === "photo" ? pickImageAttachments(room) : pickDocumentAttachments(room)));
  }

  function openPicker() {
    setQuery("");
    setPicking(true);
  }

  function closePicker() {
    Keyboard.dismiss();
    setPicking(false);
    setQuery("");
  }

  function pick(choice: RepoChoice | null) {
    setRepo(choice);
    closePicker();
  }

  function pickModel(next: string) {
    setModel(next);
    rememberDeviceDefaults({ model: next });
  }

  function pickEffort(next: string) {
    setEffortKey(next);
    rememberDeviceDefaults({ effortKey: next });
  }

  function pickMode(next: PermissionModeKey) {
    setPermissionMode(next);
    rememberDeviceDefaults({ permissionMode: next });
  }

  const repoShort = repo ? (repo.label.split("/").pop() ?? repo.label) : null;
  const selectedModel = capabilities.models.find((m) => m.value === model);
  const modelLabel = selectedModel ? modelFullName(selectedModel) : model || "Default";
  const effort = EFFORT_LEVELS.find((e) => e.key === effortKey);
  const mode = PERMISSION_MODES.find((m) => m.key === permissionMode);
  const status = error ?? progress ?? (connection !== "open" ? "Connecting to the daemon…" : findingRepo ? "Finding the repo…" : projectMissing ? `No project named “${initialProject}” here. Pick one, or send to chat without a repo.` : null);

  return (
    <KeyboardAvoidingView style={[styles.fill, { paddingTop: insets.top + 10 }]} behavior="padding" keyboardVerticalOffset={0}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backRow}
          onPress={picking ? closePicker : onBack}
          disabled={progress !== null}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, styles.flex1]} numberOfLines={1}>
          {picking ? "Repository" : "New chat"}
        </Text>
      </View>

      {picking ? (
        <View style={styles.flex1}>
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color={colors.faint} />
            <TextInput
              style={styles.search}
              value={query}
              onChangeText={setQuery}
              placeholder="Search your repos, or type owner/name"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              returnKeyType="done"
            />
            {query ? (
              <TouchableOpacity onPress={() => setQuery("")} hitSlop={8} accessibilityLabel="Clear">
                <Ionicons name="close-circle" size={16} color={colors.faint} />
              </TouchableOpacity>
            ) : null}
          </View>
          <ScrollView style={styles.flex1} contentContainerStyle={styles.repoList} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            {!query && (
              <RepoRow icon="chatbubble-outline" label="No repo" description="Just chat, in a folder of its own" selected={!repo} onPress={() => pick(null)} styles={styles} colors={colors} />
            )}
            {typedRef && (
              <RepoRow
                icon="git-branch-outline"
                label={typedRef}
                description="Clone by name"
                onPress={() => pick({ key: `gh:${typedRef}`, label: typedRef, description: null, isPrivate: false, fullName: typedRef, local: null })}
                styles={styles}
                colors={colors}
              />
            )}
            {matches.map((c) => (
              <RepoRow
                key={c.key}
                icon={c.isPrivate ? "lock-closed-outline" : "folder-outline"}
                label={c.label}
                description={c.description}
                hint={c.local ? null : "clones on start"}
                selected={repo?.key === c.key}
                onPress={() => pick(c)}
                styles={styles}
                colors={colors}
              />
            ))}
            {choices && github && query && !typedRef && matches.length === 0 && <Text style={styles.note}>No repo matches “{typed}”.</Text>}
            {(!choices || !github) && (
              <View style={styles.noteRow}>
                <ActivityIndicator size="small" color={colors.faint} />
                <Text style={styles.note}>Loading your GitHub repos…</Text>
              </View>
            )}
            {github && !github.available && <Text style={styles.note}>{github.reason ?? "The daemon has no GitHub login."} Showing this host's checkouts.</Text>}
          </ScrollView>
        </View>
      ) : (
        <>
          <ScrollView style={styles.flex1} contentContainerStyle={styles.hero} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            <Text style={styles.heroTitle}>What should we work on?</Text>
            <TouchableOpacity onPress={openPicker} disabled={progress !== null} activeOpacity={0.6} style={styles.heroSubRow}>
              <Ionicons name={repo ? "folder-outline" : "chatbubble-outline"} size={14} color={colors.dim} />
              <Text style={styles.heroSub} numberOfLines={1}>
                {repo ? `In ${repo.fullName ?? repo.label}` : "A chat of its own, no repo"}
              </Text>
            </TouchableOpacity>
            {status && (
              <View style={styles.statusRow}>
                {!error && (progress !== null || connection !== "open" || findingRepo) && <ActivityIndicator size="small" color={colors.faint} />}
                <Text style={[styles.statusText, error ? { color: colors.danger } : null]}>{status}</Text>
              </View>
            )}
          </ScrollView>

          {(attachments.length > 0 || uploads.length > 0) && (
            <View style={styles.pendingAttachRow}>
              {/* As in a chat and on the web: a photo shows its thumbnail and opens full screen on a tap; the ✕ removes it. */}
              {attachments.map((a) => {
                const isImage = a.mediaType.startsWith("image/");
                return (
                  <TouchableOpacity
                    key={a.id}
                    style={styles.attachChip}
                    activeOpacity={isImage ? 0.7 : 1}
                    disabled={!isImage}
                    onPress={() => {
                      const images = attachments.filter((x) => x.mediaType.startsWith("image/"));
                      Keyboard.dismiss();
                      setPreview({ images, index: Math.max(0, images.indexOf(a)) });
                    }}
                    accessibilityLabel={isImage ? `Preview ${a.name}` : a.name}
                  >
                    {isImage ? (
                      <Image source={attachmentSource(a, config)} style={styles.attachThumb} />
                    ) : (
                      <Ionicons name={a.mediaType === "application/zip" ? "archive-outline" : "document-outline"} size={14} color={colors.dim} />
                    )}
                    <Text style={styles.attachName} numberOfLines={1}>
                      {a.name}
                    </Text>
                    <TouchableOpacity
                      onPress={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityLabel={`Remove ${a.name}`}
                    >
                      <Ionicons name="close" size={14} color={colors.faint} />
                    </TouchableOpacity>
                  </TouchableOpacity>
                );
              })}
              {uploads.map((u) => (
                <TouchableOpacity key={u.id} style={styles.attachChip} onPress={() => removeUpload(u.id)} accessibilityLabel={`Remove ${u.name}`}>
                  {u.ref || u.error ? (
                    <Ionicons name={u.error ? "alert-circle-outline" : "document-outline"} size={14} color={u.error ? colors.danger : colors.dim} />
                  ) : (
                    <ActivityIndicator size="small" color={colors.dim} />
                  )}
                  <Text style={styles.attachName} numberOfLines={1}>
                    {u.name}
                  </Text>
                  <Text style={styles.attachMeta}>{u.error ? "failed" : u.ref ? formatBytes(u.size) : `${Math.round(u.progress * 100)}%`}</Text>
                  <Ionicons name="close" size={14} color={colors.faint} />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* The chat screen's open composer: the text on top, the controls under it. */}
          <View style={styles.composerWrap}>
            <View style={styles.composerPill}>
              <View style={styles.composerRow}>
                <TextInput
                  style={styles.composerInput}
                  value={text}
                  onChangeText={setText}
                  placeholder="Describe a task or ask a question"
                  placeholderTextColor={colors.faint}
                  multiline
                  autoFocus
                  editable={progress === null}
                />
              </View>
              <View style={styles.composerRow}>
                <TouchableOpacity style={styles.roundIconBtn} onPress={() => openSheet(setAttachMenuOpen)} accessibilityLabel="Add to chat">
                  <Ionicons name="add" size={22} color={colors.text} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.repoChip} onPress={openPicker} disabled={progress !== null} accessibilityLabel="Repository">
                  <Ionicons name={repo ? "folder-outline" : "chatbubble-outline"} size={14} color={colors.dim} />
                  <Text style={styles.chipText} numberOfLines={1}>
                    {repoShort ?? "No repo"}
                  </Text>
                  <Ionicons name="chevron-down" size={12} color={colors.faint} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.modelChip} onPress={() => openSheet(setModelSheetOpen)} accessibilityLabel="Model and effort">
                  <Text style={styles.modelChipText} numberOfLines={1}>
                    {modelLabel} <Text style={styles.modelChipEffort}>{effort?.label ?? "Medium"}</Text>
                  </Text>
                </TouchableOpacity>
                <View style={styles.flex1} />
                {/* While starting, a spinner instead of the arrow, and full strength: it's working, not unavailable. */}
                <TouchableOpacity
                  style={[styles.sendBtn, !canSend && progress === null && styles.disabled]}
                  disabled={!canSend}
                  onPress={start}
                  accessibilityLabel={progress !== null ? "Starting" : "Send"}
                >
                  {progress !== null ? <ActivityIndicator size="small" color={colors.accentFg} /> : <Ionicons name="arrow-up" size={19} color={colors.accentFg} />}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </>
      )}

      <Sheet visible={attachMenuOpen} onClose={() => setAttachMenuOpen(false)} title="Add to chat" colors={colors}>
        <View style={styles.sheetBody}>
          <View style={styles.attachTileRow}>
            <TouchableOpacity style={styles.attachTile} onPress={() => attach("photo")}>
              <View style={styles.attachTileIcon}>
                <Ionicons name="images-outline" size={22} color={colors.text} />
              </View>
              <Text style={styles.attachTileLabel}>Photos</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachTile} onPress={() => attach("file")}>
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
        options={capabilities.models.map((m) => {
          const { title, subtitle } = modelMenuLabel(m);
          return { key: m.value, label: title, description: subtitle };
        })}
        selectedKey={model}
        onSelect={pickModel}
        colors={colors}
        styles={styles}
        footer={
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
        }
      />
      <PickerSheet
        visible={effortSheetOpen}
        onClose={() => setEffortSheetOpen(false)}
        title="Thinking effort"
        options={EFFORT_LEVELS.map((e) => ({ key: e.key, label: e.label }))}
        selectedKey={effortKey}
        onSelect={pickEffort}
        colors={colors}
        styles={styles}
      />
      <PickerSheet
        visible={modeSheetOpen}
        onClose={() => setModeSheetOpen(false)}
        title="Permission mode"
        options={PERMISSION_MODES.map((m) => ({ key: m.key, label: m.label, description: m.description }))}
        selectedKey={permissionMode ?? ""}
        onSelect={(k) => pickMode(k as PermissionModeKey)}
        colors={colors}
        styles={styles}
      />
      <ImageViewer images={preview?.images ?? []} index={preview?.index ?? null} onClose={() => setPreview(null)} />
    </KeyboardAvoidingView>
  );
}

function RepoRow({
  icon,
  label,
  description,
  hint,
  selected,
  onPress,
  styles,
  colors,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  description?: string | null;
  hint?: string | null;
  selected?: boolean;
  onPress: () => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <TouchableOpacity style={[styles.repoRow, selected && styles.repoRowSelected]} onPress={onPress}>
      <Ionicons name={icon} size={17} color={selected ? colors.accent : colors.dim} />
      <View style={styles.flex1}>
        <Text style={styles.repoName} numberOfLines={1}>
          {label}
        </Text>
        {description ? (
          <Text style={styles.repoSub} numberOfLines={1}>
            {description}
          </Text>
        ) : null}
      </View>
      {hint ? <Text style={styles.repoHint}>{hint}</Text> : null}
      {selected ? <Ionicons name="checkmark" size={19} color={colors.accent} /> : null}
    </TouchableOpacity>
  );
}

/** The chat screen's option picker (see SessionView): one grouped card, the pick marked by a tick. */
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
  footer?: ReactNode;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title} colors={colors}>
      <ScrollView contentContainerStyle={styles.pickerList} keyboardShouldPersistTaps="handled">
        {options.length > 0 && (
          <View style={styles.pickerGroup}>
            {options.map((o, i) => (
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
                {o.key === selectedKey && <Ionicons name="checkmark" size={21} color={colors.accent} />}
              </TouchableOpacity>
            ))}
          </View>
        )}
        {footer}
      </ScrollView>
    </Sheet>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.bg },
    flex1: { flex: 1 },
    header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingBottom: 14 },
    backRow: { flexDirection: "row", alignItems: "center" },
    headerTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },

    hero: { flexGrow: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 28, paddingVertical: 24, gap: 10 },
    heroTitle: { color: colors.text, fontSize: 24, fontWeight: "600", textAlign: "center", letterSpacing: -0.3 },
    heroSubRow: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" },
    heroSub: { color: colors.dim, fontSize: 14, flexShrink: 1 },
    statusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8, maxWidth: "100%" },
    statusText: { color: colors.faint, fontSize: 13, flexShrink: 1, textAlign: "center" },

    searchWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 14,
      marginBottom: 8,
      paddingHorizontal: 14,
      backgroundColor: colors.panel,
      borderRadius: radius.pill,
      ...softShadow(colors),
    },
    search: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 11 },
    repoList: { paddingHorizontal: 14, paddingBottom: 16, gap: 6 },
    repoRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.md, backgroundColor: colors.inset },
    repoRowSelected: { backgroundColor: withAlpha(colors.accent, 0.16) },
    repoName: { color: colors.text, fontSize: 15, fontWeight: "600" },
    repoSub: { color: colors.faint, fontSize: 12, marginTop: 2 },
    repoHint: { color: colors.faint, fontSize: 12 },
    noteRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 4 },
    note: { color: colors.faint, fontSize: 12, paddingVertical: 4, paddingHorizontal: 4, flexShrink: 1 },

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
    // flexShrink, not flex: 1: the chip sizes to its content, so a flex-basis of 0 squeezed the name to nothing.
    attachThumb: { width: 22, height: 22, borderRadius: radius.xs },
    attachName: { flexShrink: 1, color: colors.text, fontSize: 12 },
    attachMeta: { color: colors.faint, fontSize: 11 },

    composerWrap: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 10 },
    composerPill: {
      flexDirection: "column",
      alignItems: "stretch",
      gap: 2,
      backgroundColor: colors.panel,
      borderRadius: radius.xl,
      paddingHorizontal: 4,
      paddingTop: 6,
      paddingBottom: 4,
      ...softShadow(colors),
    },
    composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 4 },
    composerInput: {
      flex: 1,
      color: colors.text,
      fontSize: 15,
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 10,
      minHeight: 44,
      maxHeight: 160,
      textAlignVertical: "center",
      includeFontPadding: false,
    },
    roundIconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
    repoChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      maxWidth: 140,
      height: 38,
      paddingHorizontal: 12,
      borderRadius: radius.pill,
      backgroundColor: withAlpha(colors.text, 0.07),
    },
    chipText: { color: colors.text, fontSize: 14, fontWeight: "500", flexShrink: 1 },
    modelChip: { backgroundColor: withAlpha(colors.text, 0.07), borderRadius: radius.pill, paddingHorizontal: 14, height: 38, justifyContent: "center", flexShrink: 1, maxWidth: 220 },
    modelChipText: { color: colors.text, fontSize: 14, fontWeight: "500" },
    modelChipEffort: { color: colors.dim, fontWeight: "400" },
    sendBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
    disabled: { opacity: 0.35 },

    sheetBody: { paddingHorizontal: 14, paddingBottom: 16, gap: 10 },
    attachTileRow: { flexDirection: "row", gap: 10 },
    attachTile: { flex: 1, alignItems: "center", gap: 10, backgroundColor: colors.inset, borderRadius: radius.lg, paddingVertical: 18 },
    attachTileIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.panel, alignItems: "center", justifyContent: "center" },
    attachTileLabel: { color: colors.text, fontSize: 15 },
    sheetCardRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.inset, borderRadius: radius.lg, paddingHorizontal: 16, paddingVertical: 14 },
    sheetCardIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.panel, alignItems: "center", justifyContent: "center" },
    sheetCardLabel: { color: colors.text, fontSize: 16, flexShrink: 1 },
    sheetCardSub: { color: colors.dim, fontSize: 13, marginTop: 2 },
    sheetCardValue: { flex: 1, textAlign: "right", color: colors.dim, fontSize: 15 },
    pickerList: { paddingHorizontal: 14, gap: 8, paddingBottom: 8 },
    pickerGroup: { borderRadius: radius.lg, backgroundColor: colors.inset, overflow: "hidden" },
    pickerRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
    pickerRowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    pickerRowLabel: { color: colors.text, fontSize: 16 },
    pickerRowDesc: { color: colors.dim, fontSize: 13, marginTop: 2 },
  });
