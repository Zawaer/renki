import type { Repo, Session } from "@crc/protocol";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { Alert, FlatList, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useClient } from "../lib/client";
import { statusColorFor, type ThemeColors, useTheme } from "../theme";
import { AccountsBar } from "./AccountsBar";
import { PairDevice } from "./PairDevice";

export function SessionList({
  onSelect,
  onReset,
  onReconnect,
}: {
  onSelect: (id: string) => void;
  onReset: () => void;
  onReconnect: (baseUrl: string) => Promise<void>;
}) {
  const colors = useTheme();
  const statusColor = statusColorFor(colors);
  const styles = makeStyles(colors);
  const { rest, realtime } = useClient();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [creating, setCreating] = useState(false);
  const [pairing, setPairing] = useState(false);

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
    await rest.deleteSession(id);
    refresh();
  }

  const active = sessions.filter((s) => s.status !== "archived");
  const archived = sessions.filter((s) => s.status === "archived");

  return (
    <View style={styles.fill}>
      <View style={styles.header}>
        <Text style={styles.title}>Sessions</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.iconLink} onPress={() => setPairing(true)}>
            <Ionicons name="qr-code-outline" size={15} color={colors.dim} />
            <Text style={styles.link}>Pair a device</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconLink} onPress={onReset}>
            <Ionicons name="log-out-outline" size={15} color={colors.dim} />
            <Text style={styles.link}>Disconnect</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.newBtn} onPress={() => setCreating(true)}>
            <Ionicons name="add" size={14} color={colors.accentFg} />
            <Text style={styles.newBtnText}>New</Text>
          </TouchableOpacity>
        </View>
      </View>

      <PairDevice visible={pairing} onClose={() => setPairing(false)} onReconnect={onReconnect} />

      <ScrollView style={styles.list}>
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
      </ScrollView>

      <AccountsBar />

      {creating && (
        <NewSessionModal
          colors={colors}
          styles={styles}
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            refresh();
            realtime.takeControl(s.id);
            onSelect(s.id);
          }}
        />
      )}
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
}: {
  session: Session;
  colors: ThemeColors;
  styles: Styles;
  statusColor: Record<string, string>;
  onSelect: () => void;
  onArchive?: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.title ?? session.repoName);

  function confirmDelete() {
    setActionsOpen(false);
    Alert.alert("Delete this session?", "Its transcript will be gone for good.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: onDelete },
    ]);
  }

  function commitRename() {
    setRenaming(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.title) onRename(trimmed);
  }

  return (
    <>
      <TouchableOpacity style={styles.row} onPress={onSelect}>
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
            {session.hasPendingPermission ? "awaiting permission" : session.status}
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

      <Modal transparent visible={actionsOpen} animationType="fade" onRequestClose={() => setActionsOpen(false)}>
        <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={() => setActionsOpen(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.sheetCard}>
            {onArchive && (
              <TouchableOpacity
                style={styles.sheetRow}
                onPress={() => {
                  setActionsOpen(false);
                  onArchive();
                }}
              >
                <Ionicons name="archive-outline" size={17} color={colors.text} />
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
              <Ionicons name="create-outline" size={17} color={colors.text} />
              <Text style={styles.sheetRowText}>Edit title</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetRow} onPress={confirmDelete}>
              <Ionicons name="trash-outline" size={17} color={colors.danger} />
              <Text style={[styles.sheetRowText, { color: colors.danger }]}>Delete</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <Modal transparent visible={renaming} animationType="fade" onRequestClose={() => setRenaming(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Rename session</Text>
            <TextInput style={styles.input} value={draft} onChangeText={setDraft} autoFocus onSubmitEditing={commitRename} />
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={() => setRenaming(false)}>
                <Text style={styles.link}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.newBtn} onPress={commitRename}>
                <Text style={styles.newBtnText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

function NewSessionModal({
  onClose,
  onCreated,
  colors,
  styles,
}: {
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

  useEffect(() => {
    rest.listRepos().then(setRepos).catch((e) => setError(String(e)));
  }, [rest]);

  async function create() {
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

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>New session</Text>
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
            <TouchableOpacity onPress={onClose}>
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
      </View>
    </Modal>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.bg, paddingTop: 48 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    title: { color: colors.text, fontSize: 18, fontWeight: "700" },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 16 },
    iconLink: { flexDirection: "row", alignItems: "center", gap: 4 },
    link: { color: colors.dim, fontSize: 13 },
    newBtn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.accent, borderRadius: 2, paddingHorizontal: 12, paddingVertical: 6 },
    newBtnText: { color: colors.accentFg, fontWeight: "600", fontSize: 13 },
    disabled: { opacity: 0.4 },
    list: { flex: 1 },
    empty: { color: colors.faint, padding: 20, fontSize: 14 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.panel,
    },
    dot: { width: 9, height: 9, borderRadius: 5 },
    rowText: { flex: 1 },
    rowTitle: { color: colors.text, fontSize: 15 },
    rowSub: { color: colors.faint, fontSize: 12, marginTop: 2 },
    kebab: { padding: 6, marginRight: -6 },
    archivedHeader: {
      color: colors.faint,
      fontSize: 11,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 4,
    },
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
    modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
    modalCard: {
      backgroundColor: colors.panel,
      borderTopLeftRadius: 8,
      borderTopRightRadius: 8,
      padding: 20,
      gap: 6,
      maxHeight: "80%",
    },
    modalTitle: { color: colors.text, fontSize: 17, fontWeight: "700", marginBottom: 4 },
    repoList: { maxHeight: 200 },
    repoRow: { padding: 10, borderRadius: 2, borderWidth: 1, borderColor: colors.border, marginVertical: 3 },
    repoRowSelected: { borderColor: colors.accent, backgroundColor: colors.panel2 },
    repoName: { color: colors.text, fontSize: 14 },
    label: { color: colors.dim, fontSize: 12, marginTop: 8 },
    input: {
      backgroundColor: colors.bg,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 2,
      paddingHorizontal: 12,
      paddingVertical: 9,
      color: colors.text,
      fontSize: 15,
    },
    error: { color: colors.danger, fontSize: 13, marginTop: 6 },
    modalActions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 16, marginTop: 12 },
  });
