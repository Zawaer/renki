import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { choiceReply, isUiFence, UI_FENCE_LANG, type UiBlock, type UiChecklist, type UiChoices, type UiStats } from "@renki/client-core";
import { radius, type ThemeColors, useTheme, withAlpha } from "../theme";
import { Skeleton } from "./Motion";

/**
 * Generative UI on the phone: the components an agent can put in a reply
 * with a ```renki-ui block (format in client-core's genui.ts), drawn like
 * the web's (apps/web/src/components/GenUi.tsx). Markdown's fence rule hands
 * a parsed block here; one that doesn't parse stays a code block.
 */

/**
 * Sends a picked choice as the user's message. Provided by SessionView around
 * the transcript; with no provider (a Markdown viewer outside a chat, an
 * archived chat) choices show but can't be picked.
 */
export const GenUiReplyContext = createContext<((text: string) => void) | null>(null);

export function GenUiReplyProvider({ onReply, children }: { onReply: ((text: string) => void) | null; children: ReactNode }) {
  return <GenUiReplyContext.Provider value={onReply}>{children}</GenUiReplyContext.Provider>;
}

/** The info string Markdown's fence rule draws as a placeholder (see `prepareUiBlocks`). */
export const UI_PENDING_LANG = `${UI_FENCE_LANG}-pending`;

const fenceOpen = /^( {0,3})(`{3,}|~{3,})\s*(.*)$/;
const fenceClose = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * A reply ready for the phone's Markdown: a ```renki-ui block still being
 * written (no closing fence yet, mid-stream) would otherwise run to the end
 * as half a JSON object in a code block. It's left out, or, while the reply
 * is still arriving, swapped for a placeholder fence. Closed blocks are left
 * alone: the fence rule draws them, or keeps them as code if they don't parse.
 */
export function prepareUiBlocks(md: string, pending: boolean): string {
  if (!md.includes(UI_FENCE_LANG)) return md;
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = fenceOpen.exec(lines[i]!);
    if (!open) continue;
    const fence = open[2]!;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const close = fenceClose.exec(lines[j]!);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      // An unclosed ordinary code block runs to the end, as Markdown has it.
      if (!isUiFence(open[3])) return md;
      return [...lines.slice(0, i), ...(pending ? ["```" + UI_PENDING_LANG, "```"] : [])].join("\n");
    }
    i = end;
  }
  return md;
}

export function GenUi({ block }: { block: UiBlock }) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  switch (block.type) {
    case "choices":
      return <Choices block={block} colors={colors} styles={styles} />;
    case "checklist":
      return <Checklist block={block} colors={colors} styles={styles} />;
    case "stats":
      return <Stats block={block} styles={styles} />;
  }
}

/** Shown in place of a block while it's still streaming in. */
export function GenUiPending() {
  return <Skeleton width="100%" height={64} radius={radius.md} style={{ marginBottom: 8 }} />;
}

type Styles = ReturnType<typeof makeStyles>;

/** Choices answered in this app run, by question and options (see Choices). */
const pickedChoices = new Map<string, number>();

function Choices({ block, colors, styles }: { block: UiChoices; colors: ThemeColors; styles: Styles }) {
  const onReply = useContext(GenUiReplyContext);
  /**
   * What was picked, the rest dimmed so it's clear what was sent. Kept outside the component too:
   * the chat's list recycles rows and a streaming reply re-keys its blocks, and a remounted block
   * that forgot its pick could send the same answer twice.
   */
  const key = useMemo(() => JSON.stringify([block.question ?? null, block.options]), [block]);
  const [picked, setPickedState] = useState<number | null>(() => pickedChoices.get(key) ?? null);
  const setPicked = (i: number) => {
    pickedChoices.set(key, i);
    setPickedState(i);
  };
  return (
    <View style={styles.frame}>
      {block.question && <Text style={[styles.title, { marginBottom: 10 }]}>{block.question}</Text>}
      <View style={{ gap: 6 }}>
        {block.options.map((o, i) => {
          const chosen = picked === i;
          return (
            <TouchableOpacity
              key={i}
              disabled={!onReply || picked !== null}
              onPress={() => {
                setPicked(i);
                onReply?.(choiceReply(o));
              }}
              activeOpacity={0.6}
              accessibilityRole="button"
              accessibilityState={{ disabled: !onReply || picked !== null, selected: chosen }}
              accessibilityHint={onReply ? "Sends this as your reply" : undefined}
              style={[
                styles.option,
                chosen && { borderColor: colors.accent, backgroundColor: withAlpha(colors.accent, 0.12) },
                picked !== null && !chosen && { opacity: 0.5 },
              ]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.optionLabel}>{o.label}</Text>
                {o.detail && <Text style={[styles.muted, { marginTop: 2 }]}>{o.detail}</Text>}
              </View>
              {onReply && (
                <Ionicons
                  name={chosen ? "checkmark" : "arrow-up"}
                  size={15}
                  color={chosen ? colors.accent : colors.faint}
                  style={{ marginLeft: 8 }}
                />
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function Checklist({ block, colors, styles }: { block: UiChecklist; colors: ThemeColors; styles: Styles }) {
  const done = block.items.filter((i) => i.done).length;
  return (
    <View style={styles.frame}>
      <View style={styles.checkHead}>
        <Text style={[styles.title, { flex: 1 }]}>{block.title ?? "Checklist"}</Text>
        <Text style={[styles.muted, styles.tabular]}>
          {done} of {block.items.length}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.trackFill, { width: `${(done / block.items.length) * 100}%` }]} />
      </View>
      <View style={{ gap: 6 }}>
        {block.items.map((it, i) => (
          <View key={i} style={{ flexDirection: "row", gap: 10 }}>
            <View
              style={[styles.tick, it.done && { borderColor: colors.ok, backgroundColor: colors.ok }]}
              accessibilityLabel={it.done ? "Done" : "Not done"}
            >
              {it.done && <Ionicons name="checkmark" size={11} color={colors.bg} />}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.itemText, it.done && { color: colors.dim }]}>{it.text}</Text>
              {it.detail && <Text style={styles.muted}>{it.detail}</Text>}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function Stats({ block, styles }: { block: UiStats; styles: Styles }) {
  return (
    <View style={{ marginBottom: 8 }}>
      {block.title && <Text style={[styles.title, { marginBottom: 8 }]}>{block.title}</Text>}
      <View style={styles.statGrid}>
        {block.items.map((s, i) => (
          <View key={i} style={[styles.frame, styles.statTile]}>
            <Text style={styles.muted}>{s.label}</Text>
            <Text style={[styles.statValue, styles.tabular]}>{s.value}</Text>
            {s.note && <Text style={[styles.muted, { marginTop: 2 }]}>{s.note}</Text>}
          </View>
        ))}
      </View>
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    frame: {
      backgroundColor: colors.panel,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 8,
    },
    title: { color: colors.text, fontSize: 15, fontWeight: "600", lineHeight: 20 },
    muted: { color: colors.dim, fontSize: 12.5, lineHeight: 17 },
    tabular: { fontVariant: ["tabular-nums"] },
    option: {
      flexDirection: "row",
      alignItems: "center",
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    optionLabel: { color: colors.text, fontSize: 14.5, lineHeight: 20 },
    checkHead: { flexDirection: "row", alignItems: "baseline", gap: 12, marginBottom: 8 },
    track: { height: 4, borderRadius: radius.pill, backgroundColor: colors.inset, overflow: "hidden", marginBottom: 12 },
    trackFill: { height: "100%", borderRadius: radius.pill, backgroundColor: colors.ok },
    tick: {
      width: 16,
      height: 16,
      marginTop: 2,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.faint,
      alignItems: "center",
      justifyContent: "center",
    },
    itemText: { color: colors.text, fontSize: 14.5, lineHeight: 20 },
    statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    // Two to a row on a phone, one more on a wide screen.
    statTile: { flexGrow: 1, flexBasis: 130, marginBottom: 0 },
    statValue: { color: colors.text, fontSize: 20, fontWeight: "600", marginTop: 4 },
  });
}
