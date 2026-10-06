import { RestError } from "@renki/client-core";
import type { WorkspaceFileResponse } from "@renki/protocol";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from "react-native";
import { useClient } from "../lib/client";
import { FileLinkContext, useFileLinkTarget } from "../lib/fileLinks";
import { radius, type ThemeColors, useTheme } from "../theme";
import { Markdown } from "./Markdown";
import { Sheet } from "./Sheet";

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";
const LINE_H = 18;
const FONT = 12;
/** Rough monospace glyph width at FONT, to size the sideways-scrolling code area. */
const CHAR_W = 7.3;

export type OpenFile = { path: string; line?: number };

/**
 * One file from the session's working tree, opened from a link in a reply.
 * The phone has no Files panel, so this is the whole viewer: source with line
 * numbers (scrolled to the linked line, which is highlighted), and Markdown
 * rendered with a toggle to its source. Read-only.
 */
export function FileSheet({ sessionId, file, onClose }: { sessionId: string; file: OpenFile | null; onClose: () => void }) {
  const colors = useTheme();
  // Keep the last file while the sheet animates closed.
  const [shown, setShown] = useState<OpenFile | null>(file);
  useEffect(() => {
    if (file) setShown(file);
  }, [file]);
  const name = shown ? shown.path.slice(shown.path.lastIndexOf("/") + 1) : "";
  return (
    <Sheet visible={!!file} onClose={onClose} title={name} colors={colors}>
      {shown && <FileBody key={`${shown.path}:${shown.line ?? ""}`} sessionId={sessionId} file={shown} colors={colors} />}
    </Sheet>
  );
}

function failureText(err: unknown): string {
  if (err instanceof RestError && err.code === "no_worktree") return "This session has no working tree anymore.";
  if (err instanceof RestError && err.code === "not_found") return "That file isn't in the working tree (anymore).";
  if (err instanceof RestError && err.status === 404) return "This needs a newer daemon — it will work once the daemon is updated.";
  return err instanceof Error ? err.message : "Couldn't load this file.";
}

function FileBody({ sessionId, file, colors }: { sessionId: string; file: OpenFile; colors: ThemeColors }) {
  const { rest } = useClient();
  const { height, width } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [data, setData] = useState<WorkspaceFileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMarkdown = /\.(md|markdown|mdx)$/i.test(file.path);
  const [rendered, setRendered] = useState(isMarkdown && !file.line);
  const parent = useFileLinkTarget();
  const fromDir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";

  useEffect(() => {
    let live = true;
    rest
      .readWorkspaceFile(sessionId, file.path)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(failureText(err)));
    return () => {
      live = false;
    };
  }, [rest, sessionId, file.path]);

  const lines = useMemo(() => {
    const c = data?.content ?? "";
    return (c.endsWith("\n") ? c.slice(0, -1) : c).split("\n");
  }, [data]);
  const bodyHeight = Math.round(height * 0.62);

  let body: React.ReactNode;
  if (error) body = <Text style={styles.note}>{error}</Text>;
  else if (!data) body = <ActivityIndicator style={{ marginTop: 24 }} color={colors.dim} />;
  else if (data.binary) body = <Text style={styles.note}>Binary file — nothing to show as text.</Text>;
  else if (rendered) {
    body = (
      <ScrollView style={{ height: bodyHeight }} contentContainerStyle={styles.mdBody}>
        <FileLinkContext.Provider value={parent ? { ...parent, fromDir } : null}>
          <Markdown content={data.content ?? ""} />
        </FileLinkContext.Provider>
      </ScrollView>
    );
  } else {
    const gutter = String(lines.length).length * CHAR_W + 20;
    const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
    const contentWidth = Math.max(width, gutter + longest * CHAR_W + 32);
    const target = file.line && file.line <= lines.length ? file.line : undefined;
    body = (
      <ScrollView horizontal style={{ height: bodyHeight }} showsHorizontalScrollIndicator={false}>
        <FlatList
          style={{ width: contentWidth }}
          data={lines}
          keyExtractor={(_, i) => String(i)}
          getItemLayout={(_, i) => ({ length: LINE_H, offset: LINE_H * i, index: i })}
          initialScrollIndex={target ? Math.max(0, target - 1 - Math.floor(bodyHeight / LINE_H / 3)) : undefined}
          initialNumToRender={Math.ceil(bodyHeight / LINE_H) + 4}
          contentContainerStyle={styles.codeBody}
          renderItem={({ item, index }) => {
            const hit = index + 1 === target;
            return (
              <View style={[styles.lineRow, hit && styles.lineHit]}>
                <Text style={[styles.lineNo, { width: gutter }, hit && { color: colors.text }]}>{index + 1}</Text>
                <Text selectable style={styles.lineText}>{item || " "}</Text>
              </View>
            );
          }}
        />
      </ScrollView>
    );
  }

  return (
    <View>
      <View style={styles.metaRow}>
        <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
          {file.path}
        </Text>
        {isMarkdown && data && !data.binary && (
          <View style={styles.toggle}>
            {(["Preview", "Source"] as const).map((label) => {
              const active = (label === "Preview") === rendered;
              return (
                <TouchableOpacity key={label} onPress={() => setRendered(label === "Preview")} style={[styles.toggleBtn, active && styles.toggleActive]}>
                  <Text style={[styles.toggleText, active && { color: colors.text }]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>
      {body}
      {data?.truncated && <Text style={styles.note}>Only the first 512 KB is shown.</Text>}
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    metaRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 18, paddingBottom: 10 },
    path: { flex: 1, color: colors.dim, fontFamily: mono, fontSize: 12 },
    toggle: { flexDirection: "row", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.xs, padding: 2 },
    toggleBtn: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.xs - 2 },
    toggleActive: { backgroundColor: colors.inset },
    toggleText: { color: colors.dim, fontSize: 12 },
    note: { color: colors.dim, fontSize: 13, paddingHorizontal: 18, paddingVertical: 12 },
    mdBody: { paddingHorizontal: 18, paddingBottom: 24 },
    codeBody: { paddingBottom: 24 },
    lineRow: { flexDirection: "row", height: LINE_H, alignItems: "center", paddingRight: 16 },
    lineHit: { backgroundColor: colors.busy + "26" },
    lineNo: { color: colors.faint, fontFamily: mono, fontSize: FONT, textAlign: "right", paddingRight: 10 },
    lineText: { color: colors.text, fontFamily: mono, fontSize: FONT, lineHeight: LINE_H },
  });
}
