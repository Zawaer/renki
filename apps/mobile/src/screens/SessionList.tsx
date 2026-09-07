import { activeSessions, formatPurgeCountdown, trashedSessions } from "@crc/client-core";
import type { Repo, Session } from "@crc/protocol";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { Alert, FlatList, Keyboard, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Sheet } from "../components/Sheet";
import { useClient } from "../lib/client";
import { radius, statusColorFor, type ThemeColors, useTheme, withAlpha } from "../theme";
import { AccountsBar } from "./AccountsBar";

export function SessionList({
  onSelect,
  onOpenSettings,
  onOpenStats,
}: {
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onOpenStats: () => void;
}) {
  const colors = useTheme();
  const statusColor = statusColorFor(colors);
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const { rest, realtime } = useClient();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    rest.listSessions().then(setSessions).catch(() => {});
  }, [rest]);

  useEffect(() => {
    refresh();
    // Slow safety-net poll; the `session`/`session_removed` WS pushes below
    // are what keep the list live between fetches.
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const offChanged = realtime.onSessionChanged((session) => {
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.id === session.id);
        if (idx === -1) return [session, ...prev];
        const next = prev.slice();
        next[idx] = session;
        return next;
      });
    });
    const offRemoved = realtime.onSessionRemoved((id) => {
      setSessions((prev) => prev.filter((s) => s.id !== id));
    });
    return () => {
      offChanged();
      offRemoved();
    };
  }, [realtime]);

  async function archive(id: string) {
    await rest.archiveSession(id);
    refresh();
  }

  async function rename(id: string, title: string) {
    await rest.renameSession(id, title);
    refresh();
  }

  async function del(id: string) {
    await rest.trashSession(id);
    refresh();
  }

  async function restore(id: string) {
    await rest.restoreSession(id);
    refresh();
  }

  async function purge(id: string) {
    await rest.purgeSession(id);
    refresh();
  }

  const active = activeSessions(sessions);
  const archived = sessions.filter((s) => s.status === "archived");
  const trashed = trashedSessions(sessions);

  return (
    <View style={[styles.fill, { paddingTop: insets.top + 14 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Sessions</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.iconBtn} onPress={onOpenStats} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="stats-chart-outline" size={18} color={colors.dim} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={onOpenSettings} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="settings-outline" size={19} color={colors.dim} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.newBtn} onPress={() => setCreating(true)}>
            <Ionicons name="add" size={16} color={colors.accentFg} />
            <Text style={styles.newBtnText}>New</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {active.length === 0 && <Text style={styles.empty}>No sessions yet.</Text>}
        {active.map((s) => (
          <Row
            key={s.id}
            session={s}
            colors={colors}
            styles={styles}
            statusColor={statusColor}
            onSelect={() => onSelect(s.id)}
            onArchive={() => archive(s.id)}
            onRename={(title) => rename(s.id, title)}
            onDelete={() => del(s.id)}
          />
        ))}

        {archived.length > 0 && <Text style={styles.archivedHeader}>Archived</Text>}
        {archived.map((s) => (
          <Row
            key={s.id}
            session={s}
            colors={colors}
            styles={styles}
            statusColor={statusColor}
            onSelect={() => onSelect(s.id)}
            onRename={(title) => rename(s.id, title)}
            onDelete={() => del(s.id)}
          />
        ))}

        {trashed.length > 0 && <Text style={styles.archivedHeader}>Trash</Text>}
        {trashed.map((s) => (
          <Row
            key={s.id}
            session={s}
            colors={colors}
            styles={styles}
            statusColor={statusColor}
            onSelect={() => onSelect(s.id)}
            onRename={(title) => rename(s.id, title)}
            onDelete={() => del(s.id)}
            onRestore={() => restore(s.id)}
            onPurge={() => purge(s.id)}
          />
        ))}
      </ScrollView>

      <AccountsBar />

      <NewSessionModal
        visible={creating}
        colors={colors}
        styles={styles}
        onClose={() => setCreating(false)}
        onCreated={(s) => {
          // Dismiss this modal's own keyboard (title/branch fields) before
          // navigating into SessionView's composer — closing a Modal that
          // still owns the soft keyboard while mounting a new TextInput
          // underneath can leave Android's IME stuck, so the new composer
          // doesn't respond to a tap until the screen is revisited.
          Keyboard.dismiss();
          setCreating(false);
          refresh();
          realtime.takeControl(s.id);
          onSelect(s.id);
        }}
      />
    </View>
  );
}

function Row({
  session,
  colors,
  styles,
  statusColor,
  onSelect,
  onArchive,
  onRename,
  onDelete,
  onRestore,
  onPurge,
}: {
  session: Session;
  colors: ThemeColors;
  styles: Styles;
  statusColor: Record<string, string>;
  onSelect: () => void;
  onArchive?: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  /** Both passed only for a row in the trash. */
  onRestore?: () => void;
  onPurge?: () => void;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title ?? session.repoName);

  const inTrash = session.status === "trashed";
  const countdown = formatPurgeCountdown(session.purgeAt);

  function confirmDelete() {
    setActionsOpen(false);
    Alert.alert("Move to trash?", "You can restore it for the next 30 days.", [
      { text: "Cancel", style: "cancel" },
      { text: "Move to trash", style: "destructive", onPress: onDelete },
    ]);
  }

  function confirmPurge() {
    setActionsOpen(false);
    Alert.alert("Delete permanently?", "The transcript, worktree and branch all go, with no undo.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: onPurge },
    ]);
  }

  function commitRename() {
    setRenaming(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.title) onRename(trimmed);
  }

  return (
    <>
      <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={onSelect}>
        <View
          style={[
            styles.dot,
            { backgroundColor: session.hasPendingPermission ? colors.danger : statusColor[session.status] ?? colors.faint },
          ]}
        />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {session.title || session.repoName}
          </Text>
          <Text style={styles.rowSub} numberOfLines={1}>
            {session.branch ? `${session.repoName}:${session.branch}` : session.repoName} ·{" "}
            {inTrash && countdown ? countdown : session.hasPendingPermission ? "awaiting permission" : session.status}
          </Text>
        </View>
        {session.controller && <Ionicons name="lock-closed" size={12} color={colors.accent} />}
        <TouchableOpacity
          style={styles.kebab}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={() => {
            setDraft(session.title ?? session.repoName);
            setActionsOpen(true);
          }}
        >
          <Ionicons name="ellipsis-vertical" size={16} color={colors.faint} />
        </TouchableOpacity>
      </TouchableOpacity>

      <Sheet visible={actionsOpen} onClose={() => setActionsOpen(false)} title={session.title || session.repoName} colors={colors}>
        <View style={styles.sheetBody}>
          {onArchive && (
            <TouchableOpacity
              style={styles.sheetRow}
              onPress={() => {
                setActionsOpen(false);
                onArchive();
              }}
            >
              <Ionicons name="archive-outline" size={18} color={colors.text} />
              <Text style={styles.sheetRowText}>Archive</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.sheetRow}
            onPress={() => {
              setActionsOpen(false);
              setRenaming(true);
            }}
          >
            <Ionicons name="create-outline" size={18} color={colors.text} />
            <Text style={styles.sheetRowText}>Edit title</Text>
          </TouchableOpacity>
          {onRestore && (
            <TouchableOpacity
              style={styles.sheetRow}
              onPress={() => {
                setActionsOpen(false);
                onRestore();
              }}
            >
              <Ionicons name="arrow-undo-outline" size={18} color={colors.text} />
              <Text style={styles.sheetRowText}>Restore</Text>
            </TouchableOpacity>
          )}
          {onPurge ? (
            <TouchableOpacity style={styles.sheetRow} onPress={confirmPurge}>
              <Ionicons name="trash-outline" size={18} color={colors.danger} />
              <Text style={[styles.sheetRowText, { color: colors.danger }]}>Delete permanently</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.sheetRow} onPress={confirmDelete}>
              <Ionicons name="trash-outline" size={18} color={colors.danger} />
              <Text style={[styles.sheetRowText, { color: colors.danger }]}>Move to trash</Text>
            </TouchableOpacity>
          )}
        </View>
      </Sheet>

      <Sheet visible={renaming} onClose={() => setRenaming(false)} title="Rename session" colors={colors}>
        <View style={styles.formBody}>
          <TextInput style={styles.input} value={draft} onChangeText={setDraft} autoFocus onSubmitEditing={commitRename} />
          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.textBtn} onPress={() => setRenaming(false)}>
              <Text style={styles.link}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.newBtn} onPress={commitRename}>
              <Text style={styles.newBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Sheet>
    </>
  );
}

function NewSessionModal({
  visible,
  onClose,
  onCreated,
  colors,
  styles,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (s: Session) => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  const { rest } = useClient();
  const [repos, setRepos] = useState<Repo[]>([]);
  /** null = "No repo" (a plain scratch dir, just for chatting) — a real repo's id is never empty/null. */
  const [repoId, setRepoId] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sheet stays mounted the whole time (visible just toggles it) so its open/
  // close animation has something to animate — so unlike a conditionally-
  // rendered modal, state needs an explicit reset on each open instead of
  // getting a fresh mount for free, and the repo list is re-fetched every
  // open rather than only once, in case a repo was added since the last time.
  useEffect(() => {
    if (!visible) return;
    setRepoId(null);
    setBaseBranch("");
    setTitle("");
    setBusy(false);
    setError(null);
    rest.listRepos().then(setRepos).catch((e) => setError(String(e)));
  }, [visible, rest]);

  /** Create button: check the base branch against origin first, and confirm via Alert if it's behind. */
  async function create() {
    if (!repoId) return submit();
    setBusy(true);
    setError(null);
    try {
      const status = await rest.getBranchStatus(repoId, baseBranch);
      if (status.hasRemote && status.behind > 0) {
        setBusy(false);
        Alert.alert(
          "Pull latest changes?",
          `${baseBranch} is ${status.behind} commit${status.behind === 1 ? "" : "s"} behind origin/${baseBranch}.`,
          [
            { text: "Skip", style: "cancel", onPress: () => submit() },
            { text: "Pull latest", style: "default", onPress: () => pullAndSubmit() },
          ],
        );
        return;
      }
    } catch {
      // Best-effort check — if it fails (offline, no remote, etc.) just proceed to create.
    }
    await submit();
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await rest.createSession(
          repoId ? { repoId, baseBranch, title: title.trim() || undefined } : { title: title.trim() || undefined },
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create.");
      setBusy(false);
    }
  }

  async function pullAndSubmit() {
    setBusy(true);
    setError(null);
    try {
      await rest.pullBranch(repoId!, baseBranch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to pull.");
      setBusy(false);
      return;
    }
    await submit();
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="New session" colors={colors}>
      <View style={styles.formBody}>
        <Text style={styles.label}>Repository</Text>
        <TouchableOpacity
          style={[styles.repoRow, repoId === null && styles.repoRowSelected]}
          onPress={() => {
            setRepoId(null);
            setBaseBranch("");
          }}
        >
          <Text style={styles.repoName}>No repo (just chat)</Text>
        </TouchableOpacity>
        <FlatList
          data={repos}
          keyExtractor={(r) => r.id}
          style={styles.repoList}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.repoRow, repoId === item.id && styles.repoRowSelected]}
              onPress={() => {
                setRepoId(item.id);
                setBaseBranch(item.defaultBranch);
              }}
            >
              <Text style={styles.repoName}>{item.name}</Text>
              <Text style={styles.rowSub}>{item.defaultBranch}</Text>
            </TouchableOpacity>
          )}
        />
        {repoId !== null && (
          <>
            <Text style={styles.label}>Base branch</Text>
            <TextInput style={styles.input} value={baseBranch} onChangeText={setBaseBranch} autoCapitalize="none" />
          </>
        )}
        <Text style={styles.label}>Title (optional)</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} />
        {error && <Text style={styles.error}>{error}</Text>}
        <View style={styles.modalActions}>
          <TouchableOpacity style={styles.textBtn} onPress={onClose}>
            <Text style={styles.link}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.newBtn, ((repoId !== null && !baseBranch) || busy) && styles.disabled]}
            disabled={(repoId !== null && !baseBranch) || busy}
            onPress={create}
          >
            <Text style={styles.newBtnText}>{busy ? "Creating…" : "Create"}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Sheet>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingBottom: 14,
    },
    title: { color: colors.text, fontSize: 20, fontWeight: "700" },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 14 },
    iconBtn: { padding: 2 },
    link: { color: colors.dim, fontSize: 14, fontWeight: "600" },
    newBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: colors.accent,
      borderRadius: radius.pill,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    newBtnText: { color: colors.accentFg, fontWeight: "700", fontSize: 13 },
    textBtn: { paddingHorizontal: 4, paddingVertical: 8 },
    disabled: { opacity: 0.4 },
    list: { flex: 1 },
    listContent: { padding: 12, gap: 8 },
    empty: { color: colors.faint, padding: 20, fontSize: 14 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.panel,
      borderRadius: radius.md,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    dot: { width: 9, height: 9, borderRadius: 5 },
    rowText: { flex: 1 },
    rowTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
    rowSub: { color: colors.faint, fontSize: 12, marginTop: 2 },
    kebab: { padding: 6, marginRight: -6 },
    archivedHeader: {
      color: colors.faint,
      fontSize: 11,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      paddingHorizontal: 4,
      paddingTop: 10,
      paddingBottom: 2,
    },
    sheetBody: { paddingHorizontal: 14, gap: 4, paddingTop: 6 },
    sheetRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      backgroundColor: colors.panel2,
      borderRadius: radius.md,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    sheetRowText: { color: colors.text, fontSize: 15, fontWeight: "600" },
    formBody: { paddingHorizontal: 18, paddingBottom: 8, gap: 6 },
    repoList: { maxHeight: 200 },
    repoRow: { padding: 12, borderRadius: radius.sm, backgroundColor: colors.panel2, marginVertical: 3 },
    repoRowSelected: { backgroundColor: withAlpha(colors.accent, 0.16) },
    repoName: { color: colors.text, fontSize: 14, fontWeight: "600" },
    label: { color: colors.dim, fontSize: 12, marginTop: 10, marginBottom: 2 },
    input: {
      backgroundColor: colors.panel2,
      borderRadius: radius.sm,
      paddingHorizontal: 14,
      paddingVertical: 11,
      color: colors.text,
      fontSize: 15,
    },
    error: { color: colors.danger, fontSize: 13, marginTop: 6 },
    modalActions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 16, marginTop: 14 },
  });
