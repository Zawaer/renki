import {
  EFFORT_LEVELS,
  MAX_ATTACHMENTS_PER_PROMPT,
  filterRepoChoices,
  repoChoices,
  resolveRepoChoice,
  type RepoChoice,
} from "@renki/client-core";
import type { GithubReposResponse, Repo } from "@renki/protocol";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { pickDocumentAttachments, pickImageAttachments, type PendingAttachment } from "../lib/attachments";
import { useClient, useStoreValue } from "../lib/client";
import { loadDeviceDefaults } from "../lib/composerPrefs";
import { radius, type ThemeColors, withAlpha } from "../theme";
import { Sheet } from "./Sheet";

/**
 * Start a chat by just typing, like the web's home screen: the session is
 * created when the message is sent, as a repo-less chat unless a repo is
 * picked from the chip. The list is your GitHub repos; one the host hasn't
 * checked out is cloned first. Model, effort and permissions are this
 * device's defaults, changeable in the chat afterwards.
 */
export function NewChatSheet({
  visible,
  onClose,
  onStarted,
  colors,
}: {
  visible: boolean;
  onClose: () => void;
  onStarted: (sessionId: string) => void;
  colors: ThemeColors;
}) {
  const { rest, realtime } = useClient();
  const connection = useStoreValue(realtime.status);
  const styles = makeStyles(colors);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [repo, setRepo] = useState<RepoChoice | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [local, setLocal] = useState<Repo[] | null>(null);
  const [github, setGithub] = useState<GithubReposResponse | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The sheet stays mounted (see Sheet), so each open starts over and refetches.
  useEffect(() => {
    if (!visible) return;
    setText("");
    setAttachments([]);
    setRepo(null);
    setPicking(false);
    setQuery("");
    setProgress(null);
    setError(null);
    rest.listRepos().then(setLocal).catch(() => setLocal([]));
    rest
      .listGithubRepos()
      .then(setGithub)
      .catch(() => setGithub({ available: false, reason: "Couldn't reach the daemon.", login: null, repos: [] }));
  }, [visible, rest]);

  const choices = useMemo(() => (local ? repoChoices(local, github?.available ? github.repos : null) : null), [local, github]);
  const matches = useMemo(() => filterRepoChoices(choices ?? [], query), [choices, query]);
  const typed = query.trim();
  const typedRef =
    /^[\w.-]+\/[\w.-]+$/.test(typed) && !(choices ?? []).some((c) => c.fullName?.toLowerCase() === typed.toLowerCase()) ? typed : null;

  const canSend = connection === "open" && progress === null && (text.trim().length > 0 || attachments.length > 0);

  async function start() {
    if (!canSend) return;
    setError(null);
    try {
      let target: { repoId: string; baseBranch: string } | null = null;
      if (repo) {
        if (!repo.local) setProgress(`Cloning ${repo.fullName}…`);
        const r = await resolveRepoChoice(rest, repo);
        target = { repoId: r.id, baseBranch: r.defaultBranch };
      }
      setProgress(target ? "Getting the latest from GitHub…" : "Starting…");
      const defaults = await loadDeviceDefaults();
      const session = await rest.createSession(target ? { ...target, composer: defaults } : { composer: defaults });
      realtime.takeControl(session.id);
      realtime.submitPrompt(session.id, text.trim(), {
        model: defaults.model || undefined,
        maxThinkingTokens: EFFORT_LEVELS.find((e) => e.key === defaults.effortKey)?.maxThinkingTokens ?? undefined,
        permissionMode: defaults.permissionMode,
        attachments: attachments.length > 0 ? attachments.map(({ id: _id, ...a }) => a) : undefined,
      });
      onStarted(session.id);
    } catch (e) {
      setProgress(null);
      setError(e instanceof Error ? e.message : "Couldn't start the session.");
    }
  }

  async function attach(kind: "photo" | "file") {
    const room = MAX_ATTACHMENTS_PER_PROMPT - attachments.length;
    if (room <= 0) return setError(`Up to ${MAX_ATTACHMENTS_PER_PROMPT} attachments per message.`);
    const results = await (kind === "photo" ? pickImageAttachments(room) : pickDocumentAttachments(room));
    const accepted = results.filter((r): r is PendingAttachment => !("error" in r));
    const errors = results.filter((r): r is { error: string } => "error" in r).map((r) => r.error);
    if (accepted.length > 0) setAttachments((prev) => [...prev, ...accepted]);
    setError(errors[0] ?? null);
  }

  function pick(choice: RepoChoice | null) {
    setRepo(choice);
    setPicking(false);
    setQuery("");
  }

  return (
    <Sheet visible={visible} onClose={onClose} title={picking ? "Repository" : "New chat"} colors={colors}>
      {picking ? (
        <View style={styles.body}>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search your repos, or type owner/name"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          <ScrollView style={styles.repoList} keyboardShouldPersistTaps="handled">
            {!query && <RepoRow icon="chatbubble-outline" label="No repo" description="Just chat, in a folder of its own" selected={!repo} onPress={() => pick(null)} styles={styles} colors={colors} />}
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
            {(!choices || !github) && <Text style={styles.note}>Loading your GitHub repos…</Text>}
            {github && !github.available && <Text style={styles.note}>{github.reason ?? "The daemon has no GitHub login."} Showing this host's checkouts.</Text>}
          </ScrollView>
        </View>
      ) : (
        <View style={styles.body}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Describe a task or ask a question"
            placeholderTextColor={colors.faint}
            multiline
            autoFocus
            editable={progress === null}
          />
          {attachments.length > 0 && (
            <View style={styles.chips}>
              {attachments.map((a) => (
                <TouchableOpacity key={a.id} style={styles.chip} onPress={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}>
                  <Ionicons name={a.mediaType.startsWith("image/") ? "image-outline" : a.mediaType === "application/zip" ? "archive-outline" : "document-outline"} size={13} color={colors.dim} />
                  <Text style={styles.chipText} numberOfLines={1}>
                    {a.name}
                  </Text>
                  <Ionicons name="close" size={13} color={colors.faint} />
                </TouchableOpacity>
              ))}
            </View>
          )}
          <View style={styles.bar}>
            <TouchableOpacity style={styles.iconBtn} onPress={() => attach("photo")} hitSlop={8}>
              <Ionicons name="image-outline" size={19} color={colors.dim} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconBtn} onPress={() => attach("file")} hitSlop={8}>
              <Ionicons name="attach" size={20} color={colors.dim} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.repoChip} onPress={() => setPicking(true)} disabled={progress !== null}>
              <Ionicons name={repo ? "folder-outline" : "chatbubble-outline"} size={13} color={colors.dim} />
              <Text style={styles.repoChipText} numberOfLines={1}>
                {repo ? (repo.label.split("/").pop() ?? repo.label) : "No repo"}
              </Text>
              <Ionicons name="chevron-down" size={12} color={colors.faint} />
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity style={[styles.send, !canSend && styles.disabled]} disabled={!canSend} onPress={start} accessibilityLabel="Send">
              <Ionicons name="arrow-up" size={18} color={colors.accentFg} />
            </TouchableOpacity>
          </View>
          {(progress || error || connection !== "open") && (
            <Text style={[styles.note, error ? { color: colors.danger } : null]}>{error ?? progress ?? "Connecting to the daemon…"}</Text>
          )}
        </View>
      )}
    </Sheet>
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
      <Ionicons name={icon} size={16} color={colors.dim} />
      <View style={{ flex: 1 }}>
        <Text style={styles.repoName} numberOfLines={1}>
          {label}
        </Text>
        {description ? (
          <Text style={styles.repoSub} numberOfLines={1}>
            {description}
          </Text>
        ) : null}
      </View>
      {hint ? <Text style={styles.repoSub}>{hint}</Text> : null}
    </TouchableOpacity>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: { paddingHorizontal: 18, paddingBottom: 8, gap: 8 },
    input: {
      backgroundColor: colors.inset,
      borderRadius: radius.md,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: colors.text,
      fontSize: 16,
      minHeight: 96,
      maxHeight: 220,
      textAlignVertical: "top",
    },
    search: {
      backgroundColor: colors.inset,
      borderRadius: radius.sm,
      paddingHorizontal: 14,
      paddingVertical: 11,
      color: colors.text,
      fontSize: 15,
    },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      maxWidth: 200,
      backgroundColor: colors.inset,
      borderRadius: radius.pill,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    chipText: { color: colors.text, fontSize: 12, flexShrink: 1 },
    bar: { flexDirection: "row", alignItems: "center", gap: 14 },
    iconBtn: { padding: 2 },
    repoChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      maxWidth: 170,
      backgroundColor: colors.inset,
      borderRadius: radius.pill,
      paddingHorizontal: 11,
      paddingVertical: 6,
    },
    repoChipText: { color: colors.dim, fontSize: 13, fontWeight: "600", flexShrink: 1 },
    send: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent },
    disabled: { opacity: 0.4 },
    note: { color: colors.faint, fontSize: 12, paddingVertical: 4 },
    repoList: { maxHeight: 360 },
    repoRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: radius.sm, backgroundColor: colors.inset, marginVertical: 3 },
    repoRowSelected: { backgroundColor: withAlpha(colors.accent, 0.16) },
    repoName: { color: colors.text, fontSize: 14, fontWeight: "600" },
    repoSub: { color: colors.faint, fontSize: 12, marginTop: 1 },
  });
