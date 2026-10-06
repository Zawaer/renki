import { memo, type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, type TextStyle, View, type ViewStyle } from "react-native";
import MarkdownDisplay, { MarkdownIt } from "react-native-markdown-display";
import { radius, type ThemeColors, useTheme } from "../theme";
import { FadeIn } from "./Motion";
import { parseFileLink } from "@renki/client-core";
import { useFileLinkTarget } from "../lib/fileLinks";

/** A node of the lib's markdown AST, as handed to a render rule. */
type MdNode = {
  type: string;
  key: string;
  index: number;
  content?: string;
  attributes: Record<string, string>;
  children: MdNode[];
};
type RenderRule = (node: MdNode, children: ReactNode[], parents: MdNode[], styles: any, inheritedStyles?: any) => ReactNode;

/**
 * What a link tap does. Return `true` to have the URL opened in the browser
 * (the lib's default, via Linking.openURL), `false` if you handled it. Leaving
 * the prop off opens every link in the browser.
 */
export type LinkPressHandler = (url: string) => boolean;

// The lib's bundled types trip TS2786 under @types/react 18 (its ComponentClass
// instance type predates the `refs` change), so it isn't seen as a valid JSX
// component. Narrow it to a plain function component — the runtime is unaffected;
// we only drop typing on props we don't pass.
const MD = MarkdownDisplay as unknown as (props: {
  style?: StyleSheet.NamedStyles<any>;
  rules?: Record<string, RenderRule>;
  markdownit?: unknown;
  onLinkPress?: LinkPressHandler;
  children?: ReactNode;
}) => ReactElement;

/**
 * The parser. The lib's default leaves `linkify` off, so a bare
 * https://example.com in a reply rendered as plain text. Fuzzy matching stays
 * off: it would turn file names like `main.py` or `README.md` (.py and .md are
 * country TLDs) into links to websites — only URLs with a scheme, like GFM on
 * the web. Built once so the lib's parse memo isn't busted on every render.
 */
const parser = MarkdownIt({ typographer: true, linkify: true });
parser.linkify.set({ fuzzyLink: false, fuzzyIP: false, fuzzyEmail: false });

// ---------------------------------------------------------------------------
// Tables
//
// The lib lays a table out as equal flex columns with no horizontal scroll, so
// three columns of prose get crushed into slivers on a phone. Instead each
// column gets a width from its longest cell (clamped), and the table scrolls
// sideways when that's wider than the screen — like the Mac app, with a
// rounded border and only horizontal dividers between rows.

const COL_MIN = 90;
const COL_MAX = 260;
const CELL_PAD_X = 12;
const CHAR_W = 7.6; // average glyph width at body size (15px)

function textLength(node: MdNode): number {
  if (node.type === "text" || node.type === "textgroup" || node.type === "code_inline") {
    const own = node.content?.length ?? 0;
    // Monospace pills are wider per character, and padded.
    return (node.type === "code_inline" ? own * 1.15 + 2 : own) + node.children.reduce((n, c) => n + textLength(c), 0);
  }
  return node.children.reduce((n, c) => n + textLength(c), 0);
}

/** Column widths for a table node, computed once per node. */
const widthCache = new WeakMap<MdNode, number[]>();
function columnWidths(table: MdNode): number[] {
  const cached = widthCache.get(table);
  if (cached) return cached;
  const longest: number[] = [];
  for (const section of table.children) {
    for (const row of section.children) {
      row.children.forEach((cell, i) => {
        longest[i] = Math.max(longest[i] ?? 0, textLength(cell));
      });
    }
  }
  const widths = longest.map((len) => Math.round(Math.min(COL_MAX, Math.max(COL_MIN, len * CHAR_W + CELL_PAD_X * 2))));
  widthCache.set(table, widths);
  return widths;
}

function makeTableRules(colors: ThemeColors): Record<string, RenderRule> {
  const cell: RenderRule = (node, children, parents) => {
    const table = parents.find((p) => p.type === "table");
    const width = (table && columnWidths(table)[node.index]) || COL_MIN;
    // Grow in proportion to the measured width, so a table narrower than the
    // screen still fills it and every row keeps its columns aligned.
    return (
      <View key={node.key} style={{ flexBasis: width, flexGrow: width, flexShrink: 0, paddingHorizontal: CELL_PAD_X, paddingVertical: 8 }}>
        {children}
      </View>
    );
  };
  return {
    table: (node, children) => (
      <View
        key={node.key}
        style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: "hidden", marginTop: 2, marginBottom: 10 }}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1 }}>
          <View style={{ flexGrow: 1 }}>{children}</View>
        </ScrollView>
      </View>
    ),
    thead: (node, children) => <View key={node.key}>{children}</View>,
    tbody: (node, children) => <View key={node.key}>{children}</View>,
    tr: (node, children, parents) => {
      const section = parents[0];
      // A divider under every row but the table's last.
      const last = section?.type === "tbody" && node.index === section.children.length - 1;
      return (
        <View
          key={node.key}
          style={{ flexDirection: "row", borderBottomWidth: last ? 0 : 1, borderColor: colors.border }}
        >
          {children}
        </View>
      );
    },
    th: cell,
    td: cell,
  };
}

// ---------------------------------------------------------------------------
// Selectable text
//
// Long-press to select and copy, like any web page. `selectable` only takes on
// the outermost Text of a nested run, so it goes on the lib's outer Text nodes:
// the textgroup wrapping each paragraph/heading/list item/cell's inline
// content, and code blocks (which are a single Text). Same output as the lib's
// defaults otherwise, including trimming the parser's extra trailing newline.

function codeRule(styleKey: "fence" | "code_block"): RenderRule {
  return (node, _children, _parents, styles, inheritedStyles = {}) => {
    const content = node.content?.endsWith("\n") ? node.content.slice(0, -1) : node.content;
    return (
      <Text key={node.key} selectable style={[inheritedStyles, styles[styleKey]]}>
        {content}
      </Text>
    );
  };
}

const selectableRules: Record<string, RenderRule> = {
  textgroup: (node, children, _parents, styles) => (
    <Text key={node.key} selectable style={styles.textgroup}>
      {children}
    </Text>
  ),
  fence: codeRule("fence"),
  code_block: codeRule("code_block"),
};

/**
 * Renders assistant text as Markdown, themed to match the dark UI. Mirrors the
 * web app's Markdown component, but React Native can't reuse the DOM version, so
 * this maps markdown-it's element rules to RN styles instead. Memoized on
 * `content` so streaming a new token doesn't re-parse other blocks.
 *
 * The lib renders no raw HTML, so this is safe for untrusted model output.
 */

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";

// Shared rules (everything except `body`, whose color differs for thinking).
function makeShared(colors: ThemeColors): Record<string, TextStyle | ViewStyle> {
  return {
    heading1: { color: colors.text, fontSize: 20, fontWeight: "700", marginTop: 6, marginBottom: 2 },
    heading2: { color: colors.text, fontSize: 17, fontWeight: "700", marginTop: 6, marginBottom: 2 },
    heading3: { color: colors.text, fontSize: 15, fontWeight: "700", marginTop: 4, marginBottom: 2 },
    heading4: { color: colors.dim, fontSize: 14, fontWeight: "700" },
    paragraph: { color: colors.text, marginTop: 0, marginBottom: 8 },
    strong: { fontWeight: "700", color: colors.text },
    em: { fontStyle: "italic" },
    s: { textDecorationLine: "line-through", color: colors.faint },
    link: { color: colors.link, textDecorationLine: "underline" },
    blockquote: {
      backgroundColor: colors.panel,
      borderLeftColor: colors.accent,
      borderLeftWidth: 3,
      borderRadius: radius.xs,
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginVertical: 4,
    },
    bullet_list: { marginVertical: 2 },
    ordered_list: { marginVertical: 2 },
    list_item: { marginVertical: 1 },
    code_inline: {
      backgroundColor: colors.inset,
      color: colors.text,
      fontFamily: mono,
      fontSize: 13,
      borderRadius: radius.xs,
      paddingHorizontal: 5,
      paddingVertical: 1,
    },
    code_block: { backgroundColor: colors.inset, color: colors.text, fontFamily: mono, fontSize: 12, borderRadius: radius.md, padding: 12 },
    fence: { backgroundColor: colors.inset, color: colors.text, fontFamily: mono, fontSize: 12, borderRadius: radius.md, padding: 12 },
    hr: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginVertical: 8 },
    // Text styles only: the table rules above own the layout, and the lib
    // cascades these onto the cells' text.
    th: { color: colors.text, fontWeight: "600" },
    td: { color: colors.text },
  };
}

export const Markdown = memo(function Markdown({
  content,
  muted: isMuted = false,
  onLinkPress,
}: {
  content: string;
  muted?: boolean;
  /** Intercepts link taps; without it every link opens in the browser. */
  onLinkPress?: LinkPressHandler;
}) {
  const colors = useTheme();
  const rules = useMemo(() => ({ ...selectableRules, ...makeTableRules(colors) }), [colors]);
  const fileTarget = useFileLinkTarget();
  // Every tap goes through here: a link to a file in the session's working
  // tree opens in the file sheet; any other local path is inert (the browser
  // can't open it); real URLs go to `onLinkPress`, else the browser.
  const handleLinkPress = useCallback<LinkPressHandler>(
    (url) => {
      const file = parseFileLink(url, fileTarget?.worktreePath ?? null, fileTarget?.fromDir);
      if (file && fileTarget) {
        fileTarget.onOpenFile(file.path, file.line);
        return false;
      }
      const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#") || url.startsWith("//");
      if (file || !isUrl) return false;
      return onLinkPress ? onLinkPress(url) : true;
    },
    [fileTarget, onLinkPress],
  );
  const style = useMemo(() => {
    const shared = makeShared(colors);
    return isMuted
      ? StyleSheet.create({ ...shared, body: { color: colors.faint, fontSize: 14, lineHeight: 20, fontStyle: "italic" } })
      : StyleSheet.create({ ...shared, body: { color: colors.text, fontSize: 15, lineHeight: 21 } });
  }, [colors, isMuted]);
  return (
    <MD style={style} rules={rules} markdownit={parser} onLinkPress={handleLinkPress}>
      {content}
    </MD>
  );
});

/** Split markdown into blocks at blank lines — but never inside a ``` fence, which would break the code block apart. */
function splitBlocks(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let blank = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      blank = true;
      continue;
    }
    if (blank && current.length > 0 && !inFence) {
      out.push(current.join("\n"));
      current = [];
    }
    blank = false;
    current.push(line);
  }
  if (current.length > 0) out.push(current.join("\n"));
  return out;
}

/**
 * How much of a streaming reply to show: it catches up with what's arrived
 * over ~200 ms, a word at a time, so text flows in steadily instead of
 * landing in the chunks the stream happens to deliver.
 */
function useSmoothReveal(content: string, streaming: boolean): string {
  const [shown, setShown] = useState(streaming ? "" : content);
  const target = useRef(content);
  target.current = content;
  // Keep going until caught up — also just after the stream ends, so the
  // last words flow in like the rest instead of landing all at once.
  const catchingUp = shown !== content;
  useEffect(() => {
    if (!catchingUp) return;
    const t = setInterval(() => {
      setShown((prev) => {
        const full = target.current;
        if (!full.startsWith(prev)) return full; // edited, not appended: jump
        if (prev.length >= full.length) return prev;
        const step = Math.max(4, Math.ceil((full.length - prev.length) / 6));
        let end = Math.min(full.length, prev.length + step);
        const space = full.indexOf(" ", end);
        if (space !== -1 && space - end < 12) end = space; // finish the word
        return full.slice(0, end);
      });
    }, 33);
    return () => clearInterval(t);
  }, [catchingUp]);
  return shown;
}

/**
 * Assistant prose that eases in as it streams, the phone's version of the
 * web's word-by-word fade: text flows in steadily, and each new paragraph
 * fades in as it starts. Finished paragraphs are separate memoized blocks,
 * so a new token only re-renders the one being written. A reply that was
 * never seen streaming renders as one block, as before.
 */
export function StreamingMarkdown({
  content,
  streaming,
  muted,
  onLinkPress,
}: {
  content: string;
  streaming: boolean;
  muted?: boolean;
  onLinkPress?: LinkPressHandler;
}) {
  const everStreamed = useRef(streaming);
  if (streaming) everStreamed.current = true;
  const shown = useSmoothReveal(content, streaming);
  if (!everStreamed.current) return <Markdown content={content} muted={muted} onLinkPress={onLinkPress} />;
  const blocks = splitBlocks(shown);
  return (
    <>
      {blocks.map((b, i) => (
        <FadeIn key={i} distance={3}>
          <Markdown content={b} muted={muted} onLinkPress={onLinkPress} />
        </FadeIn>
      ))}
    </>
  );
}
