import { Ionicons } from "@expo/vector-icons";
import { type ContextUsageView, formatTokenCount, RestError } from "@renki/client-core";
import type { Account, WorkspaceChangesResponse, WorkspaceDirResponse, WorkspaceFileDiffResponse } from "@renki/protocol";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from "react-native";
import { useClient } from "../lib/client";
import { radius, type ThemeColors, useTheme, withAlpha } from "../theme";
import { FileBody } from "./FileSheet";
import { Sheet } from "./Sheet";
import { UsageLimits } from "./UsageLimits";

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";

type View_ =
  | { kind: "menu" }
  | { kind: "context" }
  | { kind: "files"; dir: string; file?: string }
  | { kind: "changes"; file?: string };

/**
 * The things the web keeps in its header — context window, Files, Changes,
 * export — behind one ⋯ button, since on a phone they're rarely needed and the
 * header has no room to spare. One sheet that navigates inside itself rather
 * than sheets stacked on sheets.
 */
export function SessionToolsSheet({
  visible,
  onClose,
  onExport,
  onAgents,
  sessionId,
  context,
  hasFiles,
  hasTree,
}: {
  visible: boolean;
  onClose: () => void;
  /** Closes this sheet and opens the export one. */
  onExport: () => void;
  /** Closes this sheet and opens the agents & background tasks one. */
  onAgents: () => void;
  sessionId: string;
  context: ContextUsageView | null;
  /** The session still has a folder to browse (every live session, repo or not). */
  hasFiles: boolean;
  /** It's in a repo, so there are changes to diff. */
  hasTree: boolean;
}) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [view, setView] = useState<View_>({ kind: "menu" });
  // Every opening starts at the menu.
  useEffect(() => {
    if (visible) setView({ kind: "menu" });
  }, [visible]);

  const title =
    view.kind === "context"
      ? "Context window"
      : view.kind === "files"
        ? view.file
          ? view.file.slice(view.file.lastIndexOf("/") + 1)
          : view.dir || "Files"
        : view.kind === "changes"
          ? view.file
            ? view.file.slice(view.file.lastIndexOf("/") + 1)
            : "Changes"
          : "This chat";

  const back = () => {
    if (view.kind === "files" && view.file) setView({ kind: "files", dir: view.dir });
    else if (view.kind === "files" && view.dir) setView({ kind: "files", dir: view.dir.includes("/") ? view.dir.slice(0, view.dir.lastIndexOf("/")) : "" });
    else if (view.kind === "changes" && view.file) setView({ kind: "changes" });
    else setView({ kind: "menu" });
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={title} colors={colors}>
      {view.kind !== "menu" && (
        <TouchableOpacity style={styles.backRow} onPress={back} hitSlop={8}>
          <Ionicons name="chevron-back" size={16} color={colors.dim} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
      )}
      {view.kind === "menu" && (
        <View style={styles.body}>
          <MenuRow icon="pie-chart-outline" label="Context window" styles={styles} colors={colors} onPress={() => setView({ kind: "context" })}>
            {context && <Meter pct={context.percentage} colors={colors} small />}
          </MenuRow>
          {hasFiles && (
            <MenuRow icon="folder-outline" label="Files" styles={styles} colors={colors} onPress={() => setView({ kind: "files", dir: "" })} />
          )}
          {hasTree && (
            <MenuRow icon="git-compare-outline" label="Changes" styles={styles} colors={colors} onPress={() => setView({ kind: "changes" })} />
          )}
          <MenuRow icon="git-network-outline" label="Agents & background tasks" styles={styles} colors={colors} onPress={onAgents} />
          <MenuRow icon="download-outline" label="Export chat…" styles={styles} colors={colors} onPress={onExport} />
        </View>
      )}
      {view.kind === "context" && <ContextView context={context} colors={colors} styles={styles} />}
      {view.kind === "files" &&
        (view.file ? (
          <FileBody key={view.file} sessionId={sessionId} file={{ path: view.file }} colors={colors} />
        ) : (
          <DirView
            key={view.dir}
            sessionId={sessionId}
            dir={view.dir}
            onOpen={(path, isDir) => setView(isDir ? { kind: "files", dir: path } : { kind: "files", dir: view.dir, file: path })}
            colors={colors}
            styles={styles}
          />
        ))}
      {view.kind === "changes" &&
        (view.file ? (
          <DiffBody key={view.file} sessionId={sessionId} path={view.file} colors={colors} styles={styles} />
        ) : (
          <ChangesView sessionId={sessionId} onOpen={(path) => setView({ kind: "changes", file: path })} colors={colors} styles={styles} />
        ))}
    </Sheet>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function MenuRow({
  icon,
  label,
  onPress,
  styles,
  colors,
  children,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  styles: Styles;
  colors: ThemeColors;
  children?: React.ReactNode;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress}>
      <Ionicons name={icon} size={18} color={colors.text} />
      <Text style={styles.rowText}>{label}</Text>
      {children}
      <Ionicons name="chevron-forward" size={16} color={colors.faint} />
    </TouchableOpacity>
  );
}

function Meter({ pct: raw, colors, small = false }: { pct: number; colors: ThemeColors; small?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(raw)));
  const tone = pct >= 90 ? colors.danger : pct >= 70 ? colors.busy : colors.accent;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: small ? 0 : 1 }}>
      <View style={{ width: small ? 56 : undefined, flex: small ? undefined : 1, height: 6, borderRadius: 3, backgroundColor: colors.inset, overflow: "hidden" }}>
        <View style={{ width: `${pct}%`, height: "100%", borderRadius: 3, backgroundColor: tone }} />
      </View>
      <Text style={{ color: colors.dim, fontSize: 12, fontVariant: ["tabular-nums"] }}>{pct}%</Text>
    </View>
  );
}

/** How full the conversation is, and the account's usage limits — the web's context meter popover. */
function ContextView({ context, colors, styles }: { context: ContextUsageView | null; colors: ThemeColors; styles: Styles }) {
  const { rest } = useClient();
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    rest
      .listAccounts()
      .then((r) => live && setAccount(r.accounts.find((a) => a.active) ?? null))
      .catch(() => live && setAccount(null));
    return () => {
      live = false;
    };
  }, [rest]);
  return (
    <ScrollView contentContainerStyle={styles.body}>
      {context ? (
        <>
          <Text style={styles.label}>
            {formatTokenCount(context.usedTokens)} of {formatTokenCount(context.maxTokens)} tokens
          </Text>
          <Meter pct={context.percentage} colors={colors} />
          {context.autoCompact && <Text style={styles.note}>Claude compacts the conversation automatically as this fills.</Text>}
        </>
      ) : (
        <Text style={styles.note}>Not known yet: it's reported after the first turn.</Text>
      )}
      <Text style={[styles.label, { marginTop: 18 }]}>Usage limits{account ? ` · ${account.email}` : ""}</Text>
      {account === undefined ? (
        <ActivityIndicator color={colors.dim} style={{ marginTop: 8 }} />
      ) : account?.usage ? (
        <UsageLimits usage={account.usage} colors={colors} />
      ) : (
        <Text style={styles.note}>No usage figures for this account.</Text>
      )}
    </ScrollView>
  );
}

function failureText(err: unknown, what: string): string {
  if (err instanceof RestError && err.code === "no_worktree") return "This session has no working tree anymore.";
  return err instanceof Error ? err.message : `Couldn't load ${what}.`;
}

function DirView({
  sessionId,
  dir,
  onOpen,
  colors,
  styles,
}: {
  sessionId: string;
  dir: string;
  onOpen: (path: string, isDir: boolean) => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  const { rest } = useClient();
  const { height } = useWindowDimensions();
  const [data, setData] = useState<WorkspaceDirResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rest
      .listWorkspaceDir(sessionId, dir)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(failureText(err, "this folder")));
    return () => {
      live = false;
    };
  }, [rest, sessionId, dir]);
  if (error) return <Text style={styles.note}>{error}</Text>;
  if (!data) return <ActivityIndicator style={{ marginVertical: 24 }} color={colors.dim} />;
  return (
    <ScrollView style={{ maxHeight: Math.round(height * 0.62) }} contentContainerStyle={styles.list}>
      {data.entries.length === 0 && <Text style={styles.note}>Empty folder.</Text>}
      {data.entries.map((e) => (
        <TouchableOpacity key={e.name} style={styles.entry} onPress={() => onOpen(dir ? `${dir}/${e.name}` : e.name, e.type === "dir")}>
          <Ionicons name={e.type === "dir" ? "folder-outline" : "document-text-outline"} size={16} color={e.type === "dir" ? colors.accent : colors.dim} />
          <Text style={styles.entryText} numberOfLines={1}>
            {e.name}
          </Text>
          {e.type === "dir" && <Ionicons name="chevron-forward" size={14} color={colors.faint} />}
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function ChangesView({
  sessionId,
  onOpen,
  colors,
  styles,
}: {
  sessionId: string;
  onOpen: (path: string) => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  const { rest } = useClient();
  const { height } = useWindowDimensions();
  const [data, setData] = useState<WorkspaceChangesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rest
      .getWorkspaceChanges(sessionId)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(failureText(err, "the changes")));
    return () => {
      live = false;
    };
  }, [rest, sessionId]);
  if (error) return <Text style={styles.note}>{error}</Text>;
  if (!data) return <ActivityIndicator style={{ marginVertical: 24 }} color={colors.dim} />;
  if (!data.available) return <Text style={styles.note}>This chat has no git working tree.</Text>;
  return (
    <ScrollView style={{ maxHeight: Math.round(height * 0.62) }} contentContainerStyle={styles.list}>
      <Text style={styles.note}>
        Against {data.base ?? "the base branch"}
        {data.ahead > 0 ? ` · ${data.ahead} commit${data.ahead === 1 ? "" : "s"} ahead` : ""}
      </Text>
      {data.files.length === 0 && <Text style={styles.note}>No changes yet.</Text>}
      {data.files.map((f) => (
        <TouchableOpacity key={f.path} style={styles.entry} onPress={() => onOpen(f.path)}>
          <Text style={[styles.status, { color: f.status === "D" ? colors.danger : f.status === "M" ? colors.busy : colors.ok }]}>{f.status}</Text>
          <Text style={styles.entryText} numberOfLines={1} ellipsizeMode="head">
            {f.path}
          </Text>
          {f.added != null && <Text style={[styles.count, { color: colors.ok }]}>+{f.added}</Text>}
          {f.removed != null && <Text style={[styles.count, { color: colors.danger }]}>−{f.removed}</Text>}
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

/** One file's unified diff, coloured by line. Scrolls both ways, like the file viewer. */
function DiffBody({ sessionId, path, colors, styles }: { sessionId: string; path: string; colors: ThemeColors; styles: Styles }) {
  const { rest } = useClient();
  const { height } = useWindowDimensions();
  const [data, setData] = useState<WorkspaceFileDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rest
      .getWorkspaceFileDiff(sessionId, path)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(failureText(err, "this diff")));
    return () => {
      live = false;
    };
  }, [rest, sessionId, path]);
  if (error) return <Text style={styles.note}>{error}</Text>;
  if (!data) return <ActivityIndicator style={{ marginVertical: 24 }} color={colors.dim} />;
  const lines = data.patch.split("\n");
  return (
    <View>
      <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
        {path}
      </Text>
      <ScrollView style={{ maxHeight: Math.round(height * 0.62) }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.diff}>
          <View>
            {lines.map((line, i) => {
              const add = line.startsWith("+") && !line.startsWith("+++");
              const del = line.startsWith("-") && !line.startsWith("---");
              const hunk = line.startsWith("@@");
              return (
                <Text
                  key={i}
                  selectable
                  style={[
                    styles.diffLine,
                    add && { backgroundColor: withAlpha(colors.ok, 0.12), color: colors.ok },
                    del && { backgroundColor: withAlpha(colors.danger, 0.12), color: colors.danger },
                    hunk && { color: colors.faint },
                  ]}
                >
                  {line || " "}
                </Text>
              );
            })}
          </View>
        </ScrollView>
        {data.truncated && <Text style={styles.note}>The diff was cut short here.</Text>}
      </ScrollView>
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    body: { paddingHorizontal: 18, paddingBottom: 20 },
    list: { paddingHorizontal: 12, paddingBottom: 20 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },
    rowText: { flex: 1, color: colors.text, fontSize: 15 },
    backRow: { flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 14, paddingBottom: 8 },
    backText: { color: colors.dim, fontSize: 13 },
    label: { color: colors.text, fontSize: 14, fontWeight: "600", marginBottom: 8 },
    note: { color: colors.dim, fontSize: 13, paddingVertical: 8, paddingHorizontal: 6 },
    entry: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, paddingHorizontal: 6, borderRadius: radius.sm },
    entryText: { flex: 1, color: colors.text, fontSize: 14 },
    status: { width: 14, fontFamily: mono, fontSize: 12, fontWeight: "700" },
    count: { fontFamily: mono, fontSize: 12 },
    path: { color: colors.dim, fontFamily: mono, fontSize: 12, paddingHorizontal: 18, paddingBottom: 10 },
    diff: { paddingHorizontal: 12, paddingBottom: 20 },
    diffLine: { color: colors.text, fontFamily: mono, fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
  });
}
