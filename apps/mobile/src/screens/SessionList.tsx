import {
  activeSessions,
  displayBranch,
  formatAgo,
  formatPurgeCountdown,
  formatResumeAt,
  groupByRepo,
  sessionsNeedingAttention,
  setActiveHost,
  trashedSessions,
  unpushedBadge,
  type AttentionReason,
  type HostsState,
} from "@renki/client-core";
import type { AttachRepoRequest, GithubRepo, Repo, Session } from "@renki/protocol";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Keyboard, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { animateLayout, FadeIn, Skeleton } from "../components/Motion";
import { Sheet } from "../components/Sheet";
import { useClient } from "../lib/client";
import { loadCollapsedGroups, saveCollapsedGroups } from "../lib/sessionListPrefs";
import type { AppConfig } from "../lib/config";
import { ExportSheet } from "../components/ExportSheet";
import { NewChatSheet } from "../components/NewChatSheet";
import { radius, statusColorFor, type ThemeColors, useTheme, withAlpha } from "../theme";
import { AccountsBar } from "./AccountsBar";

type Props = {
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onOpenStats: () => void;
  onOpenSearch: () => void;
  /** With more than one host paired, the header's host name switches between them. */
  hostsState?: HostsState;
  /** The same setter Settings → Hosts uses, so a quick switch is the same switch. */
  onHostsChange?: (next: HostsState) => void;
};

/** Keyed on the host, so switching starts the list over instead of showing the last host's sessions. */
export function SessionList(props: Props) {
  const { config } = useClient();
  return <SessionListBody key={hostKey(config)} {...props} />;
}

const hostKey = (config: AppConfig) => config.hostId ?? config.baseUrl;

function SessionListBody({ onSelect, onOpenSettings, onOpenStats, onOpenSearch, hostsState, onHostsChange }: Props) {
  const colors = useTheme();
  const statusColor = statusColorFor(colors);
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const { rest, realtime, config } = useClient();
  // Seeded from the last list this app run saw, so coming back from a chat
  // shows it at once instead of blanking and reloading.
  const [cached] = useState(() => (lastSessions?.host === hostKey(config) ? lastSessions.sessions : null));
  const [sessions, setSessionsState] = useState<Session[]>(() => cached ?? []);
  const [loaded, setLoaded] = useState(cached !== null);
  const [wasLoadedAtMount] = useState(cached !== null);
  const [creating, setCreating] = useState(false);
  // Folded repo groups, remembered on the device; Archived and Trash start folded every time, as on the web.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => lastCollapsed ?? new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [switchingHost, setSwitchingHost] = useState(false);
  const setSessions = useCallback(
    (next: Session[] | ((prev: Session[]) => Session[])) => {
      setSessionsState((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        lastSessions = { host: hostKey(config), sessions: value };
        return value;
      });
    },
    [config],
  );

  const refresh = useCallback(() => {
    rest
      .listSessions()
      .then((list) => {
        setSessions(list);
        setLoaded(true);
      })
      .catch(() => {});
  }, [rest, setSessions]);

  useEffect(() => {
    refresh();
    // Slow safety-net poll; the `session`/`session_removed` WS pushes below
    // are what keep the list live between fetches.
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (lastCollapsed) return;
    let live = true;
    loadCollapsedGroups().then((keys) => {
      lastCollapsed = keys;
      if (live) setCollapsed(keys);
    });
    return () => {
      live = false;
    };
  }, []);

  function toggleGroup(key: string) {
    animateLayout();
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      lastCollapsed = next;
      saveCollapsedGroups(next);
      return next;
    });
  }

  function toggleSection(set: (fn: (v: boolean) => boolean) => void) {
    animateLayout();
    set((v) => !v);
  }

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
    try {
      await rest.archiveSession(id);
    } catch (err) {
      Alert.alert("Couldn't archive", err instanceof Error ? err.message : "Try again in a moment.");
    } finally {
      // Whatever happened, show what the daemon now says: a slow or failed request must not leave the list stale.
      refresh();
    }
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

  /** Archived → idle: its worktree is rebuilt and it takes prompts again. */
  async function unarchive(id: string) {
    try {
      await rest.unarchiveSession(id);
      onSelect(id);
    } catch (err) {
      Alert.alert("Couldn't unarchive", err instanceof Error ? err.message : "Try again in a moment.");
    }
    refresh();
  }

  async function purge(id: string) {
    await rest.purgeSession(id);
    refresh();
  }

  function confirmEmptyTrash() {
    const n = trashed.length;
    Alert.alert(`Delete ${n} session${n === 1 ? "" : "s"} permanently?`, "Everything in the trash goes, transcripts too, with no undo.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Empty trash",
        style: "destructive",
        onPress: async () => {
          try {
            await rest.emptyTrash();
          } catch (err) {
            Alert.alert("Couldn't empty the trash", err instanceof Error ? err.message : "Try again in a moment.");
          } finally {
            refresh();
          }
        },
      },
    ]);
  }

  /** Repo-less chat → repo session; errors are the sheet's to show. */
  async function attachRepo(id: string, target: AttachRepoRequest) {
    await rest.attachRepo(id, target);
    refresh();
    onSelect(id);
  }

  const active = activeSessions(sessions);
  // Grouped by repo, same as the web sidebar: the repo IS the folder, and a
  // flat list stopped being readable once several repos had sessions running.
  const groups = groupByRepo(active);
  const archived = sessions.filter((s) => s.status === "archived");
  const trashed = trashedSessions(sessions);
  const attention = useMemo(() => sessionsNeedingAttention(sessions), [sessions]);

  const hosts = hostsState?.hosts ?? [];
  const activeHost = hosts.find((h) => h.id === hostsState?.activeId);
  const canSwitch = !!hostsState && !!onHostsChange && hosts.length > 1;

  function switchHost(id: string) {
    setSwitchingHost(false);
    if (!hostsState || !onHostsChange || id === hostsState.activeId) return;
    onHostsChange(setActiveHost(hostsState, id));
  }

  return (
    <View style={[styles.fill, { paddingTop: insets.top + 14 }]}>
      <View style={styles.header}>
        {canSwitch ? (
          <TouchableOpacity style={styles.titleBtn} onPress={() => setSwitchingHost(true)} activeOpacity={0.7} accessibilityLabel="Switch host">
            <Text style={styles.title}>Sessions</Text>
            <View style={styles.hostChip}>
              <Text style={styles.hostChipText} numberOfLines={1}>
                {activeHost?.label ?? "Host"}
              </Text>
              <Ionicons name="chevron-down" size={13} color={colors.faint} />
            </View>
          </TouchableOpacity>
        ) : (
          <Text style={styles.title}>Sessions</Text>
        )}
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.iconBtn} onPress={onOpenSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="search-outline" size={19} color={colors.dim} />
          </TouchableOpacity>
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

      {!loaded ? (
        <ListSkeleton />
      ) : (
      <FadeIn enabled={!wasLoadedAtMount} distance={0} style={styles.list}>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {attention.length > 0 && (
          <View accessibilityLabel="Needs your attention">
            <Text style={[styles.sectionHeader, { paddingTop: 4 }]}>Needs your attention</Text>
            <View style={styles.attentionCard}>
              {attention.map(({ session, reason }, i) => (
                <TouchableOpacity
                  key={session.id}
                  style={[styles.attentionRow, i > 0 && styles.attentionDivider]}
                  activeOpacity={0.7}
                  onPress={() => onSelect(session.id)}
                >
                  <AttentionBadge reason={reason} resumeAt={session.resume?.at ?? null} colors={colors} styles={styles} />
                  <Text style={styles.attentionTitle} numberOfLines={1}>
                    {session.title || session.repoName}
                  </Text>
                  <Text style={styles.attentionAgo}>{formatAgo(session.lastActivityAt)}</Text>
                  <Ionicons name="chevron-forward" size={14} color={colors.faint} />
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}
        {active.length === 0 && <Text style={styles.empty}>No sessions yet.</Text>}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          return (
          <View key={g.key}>
            <TouchableOpacity style={styles.groupHeader} activeOpacity={0.7} onPress={() => toggleGroup(g.key)}>
              <Ionicons name={isCollapsed ? "chevron-forward" : "chevron-down"} size={13} color={colors.faint} />
              <Text style={styles.groupName} numberOfLines={1}>
                {g.name}
              </Text>
              {/* Rolled up from the group's sessions, so a repo with something
                  waiting on you reads as such without opening anything. */}
              {g.pending > 0 ? (
                <View style={[styles.groupBadge, { backgroundColor: withAlpha(colors.danger, 0.16) }]}>
                  <Text style={[styles.groupBadgeText, { color: colors.danger }]}>{g.pending} waiting</Text>
                </View>
              ) : g.busy > 0 ? (
                <View style={[styles.groupBadge, { backgroundColor: withAlpha(colors.busy, 0.16) }]}>
                  <Text style={[styles.groupBadgeText, { color: colors.busy }]}>{g.busy} working</Text>
                </View>
              ) : null}
              {isCollapsed && <Text style={styles.count}>{g.sessions.length}</Text>}
            </TouchableOpacity>
            {!isCollapsed && g.sessions.map((s) => (
              <Row
                key={s.id}
                session={s}
                colors={colors}
                styles={styles}
                statusColor={statusColor}
                onSelect={() => onSelect(s.id)}
                onArchive={() => archive(s.id)}
                onAttachRepo={s.repoId ? undefined : (target) => attachRepo(s.id, target)}
                onRename={(title) => rename(s.id, title)}
                onDelete={() => del(s.id)}
              />
            ))}
          </View>
          );
        })}

        {archived.length > 0 && (
          <TouchableOpacity style={styles.sectionToggle} activeOpacity={0.7} onPress={() => toggleSection(setShowArchived)}>
            <Ionicons name={showArchived ? "chevron-down" : "chevron-forward"} size={13} color={colors.faint} />
            <Text style={styles.sectionHeader}>Archived</Text>
            <Text style={styles.count}>{archived.length}</Text>
          </TouchableOpacity>
        )}
        {showArchived && archived.map((s) => (
          <Row
            key={s.id}
            session={s}
            colors={colors}
            styles={styles}
            statusColor={statusColor}
            onSelect={() => onSelect(s.id)}
            onUnarchive={() => unarchive(s.id)}
            onRename={(title) => rename(s.id, title)}
            onDelete={() => del(s.id)}
          />
        ))}

        {trashed.length > 0 && (
          <View style={styles.sectionRow}>
            <TouchableOpacity style={[styles.sectionToggle, styles.sectionToggleFill]} activeOpacity={0.7} onPress={() => toggleSection(setShowTrash)}>
              <Ionicons name={showTrash ? "chevron-down" : "chevron-forward"} size={13} color={colors.faint} />
              <Text style={styles.sectionHeader}>Trash</Text>
              <Text style={styles.count}>{trashed.length}</Text>
            </TouchableOpacity>
            {showTrash && (
              <TouchableOpacity style={styles.emptyBtn} onPress={confirmEmptyTrash} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.emptyBtnText}>Empty trash</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {showTrash && trashed.map((s) => (
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
      </FadeIn>
      )}

      {/* The quick way in, like the Claude app's: tap and type. */}
      <TouchableOpacity style={styles.askBar} onPress={() => setCreating(true)} activeOpacity={0.8}>
        <Ionicons name="chatbubble-outline" size={16} color={colors.faint} />
        <Text style={styles.askBarText}>Ask Claude anything…</Text>
      </TouchableOpacity>

      <AccountsBar />

      <NewChatSheet
        visible={creating}
        colors={colors}
        onClose={() => setCreating(false)}
        onStarted={(id) => {
          // Dismiss the sheet's own keyboard before navigating into
          // SessionView's composer — closing a Modal that still owns the soft
          // keyboard while mounting a new TextInput underneath can leave
          // Android's IME stuck, so the new composer doesn't respond to a tap
          // until the screen is revisited.
          Keyboard.dismiss();
          setCreating(false);
          refresh();
          onSelect(id);
        }}
      />

      {canSwitch && (
        <Sheet visible={switchingHost} onClose={() => setSwitchingHost(false)} title="Switch host" colors={colors}>
          <View style={styles.sheetBody}>
            {hosts.map((h) => {
              const on = h.id === hostsState?.activeId;
              return (
                <TouchableOpacity key={h.id} style={[styles.sheetRow, on && styles.repoRowSelected]} onPress={() => switchHost(h.id)}>
                  <Ionicons name="server-outline" size={18} color={on ? colors.accent : colors.dim} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.sheetRowText} numberOfLines={1}>
                      {h.label}
                    </Text>
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {h.baseUrl}
                    </Text>
                  </View>
                  {on && <Ionicons name="checkmark" size={18} color={colors.accent} />}
                </TouchableOpacity>
              );
            })}
          </View>
        </Sheet>
      )}
    </View>
  );
}

/** Why a chat is on the attention list, in a word or two and a colour. Same words as the web's Home. */
function AttentionBadge({ reason, resumeAt, colors, styles }: { reason: AttentionReason; resumeAt: number | null; colors: ThemeColors; styles: Styles }) {
  const { icon, tone, label } =
    reason === "permission"
      ? { icon: "shield-outline" as const, tone: colors.danger, label: "Needs approval" }
      : reason === "error"
        ? { icon: "alert-circle-outline" as const, tone: colors.danger, label: "Failed" }
        : reason === "paused"
          ? { icon: "pause-circle-outline" as const, tone: colors.busy, label: resumeAt ? formatResumeAt(resumeAt) : "Paused" }
          : { icon: "cloud-upload-outline" as const, tone: colors.busy, label: "Not pushed" };
  return (
    <View style={styles.attentionBadge}>
      <Ionicons name={icon} size={14} color={tone} />
      <Text style={[styles.attentionBadgeText, { color: tone }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Same words the web's StatusBadge uses, so a session reads the same on both. */
const STATUS_LABEL: Record<string, string> = {
  idle: "Idle",
  busy: "Working",
  error: "Error",
  archived: "Archived",
  trashed: "In trash",
};

function Row({
  session,
  colors,
  styles,
  statusColor,
  onSelect,
  onArchive,
  onUnarchive,
  onAttachRepo,
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
  /** Passed only for an archived row. */
  onUnarchive?: () => void;
  /** Passed only for an active repo-less chat. */
  onAttachRepo?: (target: AttachRepoRequest) => Promise<void>;
  onRename: (title: string) => void;
  onDelete: () => void;
  /** Both passed only for a row in the trash. */
  onRestore?: () => void;
  onPurge?: () => void;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [draft, setDraft] = useState(session.title ?? session.repoName);

  const inTrash = session.status === "trashed";
  const countdown = formatPurgeCountdown(session.purgeAt);
  // An auto-generated renki/xxxxxx branch tells the reader nothing, so it's hidden.
  const branch = displayBranch(session.branch);

  function confirmDelete() {
    setActionsOpen(false);
    const commits = session.unpushed?.commits ?? 0;
    const unpushedNote = commits > 0 ? ` ${commits} commit${commits === 1 ? " isn't" : "s aren't"} on GitHub; the branch is kept for ${commits === 1 ? "it" : "them"}.` : "";
    Alert.alert("Move to trash?", `The transcript stays restorable for 30 days. The worktree is cleaned up now.${unpushedNote}`, [
      { text: "Cancel", style: "cancel" },
      { text: "Move to trash", style: "destructive", onPress: onDelete },
    ]);
  }

  function confirmPurge() {
    setActionsOpen(false);
    Alert.alert("Delete permanently?", "The transcript goes too, with no undo.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: onPurge },
    ]);
  }

  function commitRename() {
    setRenaming(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.title) onRename(trimmed);
  }

  /** Waiting on a usage limit to reset — see Session.resume. */
  const paused = !!session.resume && session.status !== "busy";

  return (
    <>
      <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={onSelect}>
        <View
          style={[
            styles.dot,
            {
              backgroundColor: session.hasPendingPermission
                ? colors.danger
                : paused
                  ? colors.busy
                  : (statusColor[session.status] ?? colors.faint),
            },
          ]}
        />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {session.title || session.repoName}
          </Text>
          <Text style={styles.rowSub} numberOfLines={1}>
            {inTrash && countdown
              ? countdown
              : session.hasPendingPermission
                ? "Needs your approval"
                : paused
                  ? `Paused · ${formatResumeAt(session.resume!.at)}`
                  : (STATUS_LABEL[session.status] ?? session.status)}
            {branch ? ` · ${branch}` : ""}
          </Text>
        </View>
        {unpushedBadge(session.unpushed) && (
          <Text style={{ color: colors.busy, fontSize: 11, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{unpushedBadge(session.unpushed)}</Text>
        )}
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

      <ExportSheet sessionId={session.id} title={session.title || session.repoName} visible={exportOpen} onClose={() => setExportOpen(false)} colors={colors} />
      <Sheet visible={actionsOpen} onClose={() => setActionsOpen(false)} title={session.title || session.repoName} colors={colors}>
        <View style={styles.sheetBody}>
          {onUnarchive && (
            <TouchableOpacity
              style={styles.sheetRow}
              onPress={() => {
                setActionsOpen(false);
                onUnarchive();
              }}
            >
              <Ionicons name="arrow-undo-outline" size={18} color={colors.text} />
              <Text style={styles.sheetRowText}>Unarchive</Text>
            </TouchableOpacity>
          )}
          {onArchive && (
            <TouchableOpacity
              style={styles.sheetRow}
              onPress={() => {
                setActionsOpen(false);
                const commits = session.unpushed?.commits ?? 0;
                if (commits === 0) return onArchive();
                Alert.alert(
                  "Archive anyway?",
                  `${commits} commit${commits === 1 ? " isn't" : "s aren't"} on GitHub yet. The branch is kept, so unarchiving brings ${commits === 1 ? "it" : "them"} back.`,
                  [
                    { text: "Cancel", style: "cancel" },
                    { text: "Archive", onPress: onArchive },
                  ],
                );
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
              setExportOpen(true);
            }}
          >
            <Ionicons name="download-outline" size={18} color={colors.text} />
            <Text style={styles.sheetRowText}>Export…</Text>
          </TouchableOpacity>
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
          {onAttachRepo && (
            <TouchableOpacity
              style={styles.sheetRow}
              onPress={() => {
                setActionsOpen(false);
                setAttaching(true);
              }}
            >
              <Ionicons name="git-branch-outline" size={18} color={colors.text} />
              <Text style={styles.sheetRowText}>Move into repo…</Text>
            </TouchableOpacity>
          )}
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

      {onAttachRepo && (
        <AttachRepoSheet visible={attaching} onClose={() => setAttaching(false)} onAttach={onAttachRepo} colors={colors} styles={styles} />
      )}

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

/**
 * Move a repo-less chat into a repo: one already on the host, or one from
 * GitHub (usually the repo the chat just made), which the daemon clones first.
 */
function AttachRepoSheet({
  visible,
  onClose,
  onAttach,
  colors,
  styles,
}: {
  visible: boolean;
  onClose: () => void;
  onAttach: (target: AttachRepoRequest) => Promise<void>;
  colors: ThemeColors;
  styles: Styles;
}) {
  const { rest } = useClient();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [github, setGithub] = useState<GithubRepo[]>([]);
  /** A local repo id, or a GitHub owner/name. */
  const [picked, setPicked] = useState<AttachRepoRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setPicked(null);
    setError(null);
    rest.listRepos().then(setRepos).catch((e) => setError(String(e)));
    // GitHub is optional: without a login the list is just the host's repos.
    rest
      .listGithubRepos()
      .then((res) => setGithub(res.repos))
      .catch(() => setGithub([]));
  }, [visible, rest]);

  const here = new Set(repos.map((r) => r.name.toLowerCase()));
  const items: { key: string; target: AttachRepoRequest; name: string; sub: string }[] = [
    ...repos.map((r) => ({ key: `l:${r.id}`, target: { repoId: r.id }, name: r.name, sub: r.defaultBranch })),
    ...github
      .filter((g) => !here.has(g.name.toLowerCase()))
      .map((g) => ({ key: `g:${g.fullName}`, target: { github: g.fullName }, name: g.fullName, sub: "GitHub · cloned first" })),
  ];
  const keyOf = (t: AttachRepoRequest | null) => (t?.repoId ? `l:${t.repoId}` : t?.github ? `g:${t.github}` : null);

  async function move() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await onAttach(picked);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't move this chat into the repo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Move into a repo" colors={colors}>
      <View style={styles.formBody}>
        <Text style={styles.rowSub}>
          The chat carries on in its own branch of the repo, with the conversation intact. Files made so far stay where they are.
        </Text>
        <FlatList
          data={items}
          keyExtractor={(i) => i.key}
          style={styles.repoList}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.repoRow, keyOf(picked) === item.key && styles.repoRowSelected]}
              onPress={() => setPicked(item.target)}
            >
              <Text style={styles.repoName}>{item.name}</Text>
              <Text style={styles.rowSub}>{item.sub}</Text>
            </TouchableOpacity>
          )}
        />
        {error && <Text style={styles.error}>{error}</Text>}
        <View style={styles.modalActions}>
          <TouchableOpacity style={styles.textBtn} onPress={onClose}>
            <Text style={styles.link}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.newBtn, (!picked || busy) && styles.disabled]} disabled={!picked || busy} onPress={move}>
            <Text style={styles.newBtnText}>{busy ? "Moving…" : "Move"}</Text>
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
    titleBtn: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, marginRight: 12 },
    hostChip: { flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 1 },
    hostChipText: { color: colors.faint, fontSize: 14, fontWeight: "600", flexShrink: 1 },
    attentionCard: { backgroundColor: colors.panel, borderRadius: radius.md, overflow: "hidden" },
    attentionRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
    attentionDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    attentionBadge: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 130 },
    attentionBadgeText: { fontSize: 12, fontWeight: "600", flexShrink: 1 },
    attentionTitle: { flex: 1, color: colors.text, fontSize: 13 },
    attentionAgo: { color: colors.faint, fontSize: 11 },
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
      borderRadius: radius.md,
      paddingHorizontal: 12,
      paddingVertical: 11,
    },
    dot: { width: 9, height: 9, borderRadius: 5 },
    rowText: { flex: 1 },
    rowTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
    rowSub: { color: colors.faint, fontSize: 12, marginTop: 2 },
    kebab: { padding: 6, marginRight: -6 },
    sectionHeader: {
      color: colors.faint,
      fontSize: 11,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    sectionRow: { flexDirection: "row", alignItems: "center" },
    sectionToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 4,
      paddingTop: 16,
      paddingBottom: 4,
    },
    sectionToggleFill: { flex: 1 },
    count: { color: colors.faint, fontSize: 11, marginLeft: "auto", fontVariant: ["tabular-nums"] },
    emptyBtn: { marginLeft: 12, paddingHorizontal: 4, paddingTop: 16, paddingBottom: 4 },
    emptyBtnText: { color: colors.danger, fontSize: 12, fontWeight: "600" },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 4,
      paddingTop: 14,
      paddingBottom: 4,
    },
    groupName: { color: colors.dim, fontSize: 13, fontWeight: "600", flexShrink: 1 },
    groupBadge: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
    groupBadgeText: { fontSize: 10, fontWeight: "700" },
    sheetBody: { paddingHorizontal: 14, gap: 4, paddingTop: 6 },
    sheetRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      backgroundColor: colors.inset,
      borderRadius: radius.md,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    sheetRowText: { color: colors.text, fontSize: 15, fontWeight: "600" },
    formBody: { paddingHorizontal: 18, paddingBottom: 8, gap: 6 },
    repoList: { maxHeight: 200 },
    repoRow: { padding: 12, borderRadius: radius.sm, backgroundColor: colors.inset, marginVertical: 3 },
    repoRowSelected: { backgroundColor: withAlpha(colors.accent, 0.16) },
    repoName: { color: colors.text, fontSize: 14, fontWeight: "600" },
    input: {
      backgroundColor: colors.inset,
      borderRadius: radius.sm,
      paddingHorizontal: 14,
      paddingVertical: 11,
      color: colors.text,
      fontSize: 15,
    },
    error: { color: colors.danger, fontSize: 13, marginTop: 6 },
    askBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginHorizontal: 12,
      marginBottom: 8,
      backgroundColor: colors.inset,
      borderRadius: radius.pill,
      paddingHorizontal: 16,
      paddingVertical: 13,
    },
    askBarText: { color: colors.faint, fontSize: 15 },
    modalActions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 16, marginTop: 14 },
  });

/** The last session list seen this app run, and whose it was — see SessionList's state seed. */
let lastSessions: { host: string; sessions: Session[] } | null = null;
/** Folded groups, once read from storage, so a return to the list doesn't unfold and refold. */
let lastCollapsed: Set<string> | null = null;

/** Placeholder rows in the shape of the list, while the first fetch is out. */
function ListSkeleton() {
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 18, gap: 22 }} accessibilityLabel="Loading sessions">
      {[0, 1].map((g) => (
        <View key={g} style={{ gap: 14 }}>
          <Skeleton width={110} height={11} />
          {[0, 1, 2].map((r) => (
            <View key={r} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Skeleton width={8} height={8} radius={4} />
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton width={r === 1 ? "58%" : "72%"} height={13} />
                <Skeleton width="36%" height={10} />
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
