import { memo, type ReactElement, type ReactNode, useMemo } from "react";
import { Platform, StyleSheet, type TextStyle, type ViewStyle } from "react-native";
import MarkdownDisplay from "react-native-markdown-display";
import { radius, type ThemeColors, useTheme } from "../theme";

// The lib's bundled types trip TS2786 under @types/react 18 (its ComponentClass
// instance type predates the `refs` change), so it isn't seen as a valid JSX
// component. Narrow it to a plain function component — the runtime is unaffected;
// we only drop typing on props we don't pass.
const MD = MarkdownDisplay as unknown as (props: {
  style?: StyleSheet.NamedStyles<any>;
  children?: ReactNode;
}) => ReactElement;

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
    link: { color: colors.accent, textDecorationLine: "underline" },
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
    table: { backgroundColor: colors.panel, borderRadius: radius.md, marginVertical: 6, overflow: "hidden" },
    th: { color: colors.text, fontWeight: "700", padding: 8, backgroundColor: colors.inset },
    td: { color: colors.text, padding: 8 },
  };
}

export const Markdown = memo(function Markdown({ content, muted: isMuted = false }: { content: string; muted?: boolean }) {
  const colors = useTheme();
  const style = useMemo(() => {
    const shared = makeShared(colors);
    return isMuted
      ? StyleSheet.create({ ...shared, body: { color: colors.faint, fontSize: 14, lineHeight: 20, fontStyle: "italic" } })
      : StyleSheet.create({ ...shared, body: { color: colors.text, fontSize: 15, lineHeight: 21 } });
  }, [colors, isMuted]);
  return <MD style={style}>{content}</MD>;
});
