import { createContext, memo, type ReactElement, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, type TextStyle, View, type ViewStyle } from "react-native";
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
type RenderRule = (node: MdNode, children: ReactNode[], parents: MdNode[], styles: any) => ReactNode;

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

/** Each column's final width: its measured width, stretched to fill a table narrower than the space it has. */
const TableWidths = createContext<number[] | null>(null);

/**
 * Every width is an exact number, worked out from the space the table
 * actually has: flex alone left the cells' text unwrapped and spilling past
 * them, and the scroll content screen-wide, so there was nothing to scroll.
 *
 * The content also claims the touch for itself. The whole reply sits in a
 * long-press Pressable (LongPressToRead), and on Android that Pressable taking
 * the gesture kept the sideways swipe from ever reaching the table.
 */
function Table({ node, children, borderColor }: { node: MdNode; children: ReactNode; borderColor: string }) {
  const [available, setAvailable] = useState(0);
  const natural = columnWidths(node);
  const total = natural.reduce((a, b) => a + b, 0);
  const widths = available > total ? natural.map((w) => (w * available) / total) : natural;
  return (
    <View
      style={{ borderWidth: 1, borderColor, borderRadius: 10, overflow: "hidden", marginTop: 2, marginBottom: 10 }}
      onLayout={(e) => setAvailable(Math.floor(e.nativeEvent.layout.width - 2))}
    >
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
        <View style={{ width: Math.max(total, available) }} onStartShouldSetResponder={() => true}>
          <TableWidths.Provider value={widths}>{children}</TableWidths.Provider>
        </View>
      </ScrollView>
    </View>
  );
}

function TableCell({ index, children }: { index: number; children: ReactNode }) {
  const widths = useContext(TableWidths);
  return <View style={{ width: widths?.[index] ?? COL_MIN, paddingHorizontal: CELL_PAD_X, paddingVertical: 8 }}>{children}</View>;
}

function makeTableRules(colors: ThemeColors): Record<string, RenderRule> {
  const cell: RenderRule = (node, children) => (
    <TableCell key={node.key} index={node.index}>
      {children}
    </TableCell>
  );
  return {
    table: (node, children) => (
      <Table key={node.key} node={node} borderColor={colors.border}>
        {children}
      </Table>
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
  const rules = useMemo(() => makeTableRules(colors), [colors]);
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

type MdToken = { type: string; tag: string; content: string; info: string; markup: string; hidden: boolean; attrGet(name: string): string | null; children: MdToken[] | null };

/**
 * A reply as plain text, for copying and sharing: what it reads as, not its
 * markdown source. Pasted into WhatsApp or a mail, "> " quote markers, **bold**
 * stars and table pipes are noise. Lists keep their bullets and numbers, a
 * link keeps its URL after the text, a table becomes one line per row.
 */
export function markdownToPlainText(md: string): string {
  const tokens = parser.parse(md, {}) as MdToken[];
  let out = "";
  const lists: { ordered: boolean; n: number }[] = [];
  let cellsInRow = 0;
  const inline = (children: MdToken[]): string => {
    let text = "";
    let href: string | null = null;
    let linkText = "";
    for (const t of children) {
      let piece = "";
      if (t.type === "text" || t.type === "code_inline") piece = t.content;
      else if (t.type === "softbreak" || t.type === "hardbreak") piece = "\n";
      else if (t.type === "link_open") {
        href = t.attrGet("href");
        linkText = "";
        continue;
      } else if (t.type === "link_close") {
        // A bare URL (linkify) already is its text; anything else keeps the URL after it.
        if (href && href !== linkText && !href.startsWith("#")) text += ` (${href})`;
        href = null;
        continue;
      } else if (t.type === "image") piece = t.content;
      if (href) linkText += piece;
      text += piece;
    }
    return text;
  };
  for (const t of tokens) {
    switch (t.type) {
      case "bullet_list_open":
        lists.push({ ordered: false, n: 0 });
        break;
      case "ordered_list_open":
        lists.push({ ordered: true, n: Number(t.attrGet("start") ?? 1) - 1 });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        lists.pop();
        if (lists.length === 0) out += "\n";
        break;
      case "list_item_open": {
        const list = lists[lists.length - 1]!;
        list.n += 1;
        out += "  ".repeat(lists.length - 1) + (list.ordered ? `${list.n}. ` : "• ");
        break;
      }
      case "inline":
        out += inline(t.children ?? []);
        break;
      case "paragraph_close":
        // In a tight list the paragraph is hidden: one line per item.
        out += t.hidden ? "\n" : lists.length > 0 ? "\n" : "\n\n";
        break;
      case "heading_close":
        out += "\n\n";
        break;
      case "fence":
      case "code_block":
        out += t.content.replace(/\n$/, "") + "\n\n";
        break;
      case "hr":
        out += "———\n\n";
        break;
      case "tr_open":
        cellsInRow = 0;
        break;
      case "th_open":
      case "td_open":
        if (cellsInRow++ > 0) out += " · ";
        break;
      case "tr_close":
        out += "\n";
        break;
      case "table_close":
        out += "\n";
        break;
    }
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

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
