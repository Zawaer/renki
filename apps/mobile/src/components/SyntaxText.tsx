import { type SyntaxKind, type SyntaxLanguage, type SyntaxToken, tokenize } from "@renki/client-core";
import { memo, useMemo } from "react";
import { type StyleProp, StyleSheet, Text, type TextStyle } from "react-native";
import { type ThemeColors, useTheme } from "../theme";

/**
 * Syntax colouring for the phone: the shared tokenizers (client-core's
 * syntax.ts) rendered as nested Text spans, coloured the way the web's Code.tsx
 * colours them but from the phone theme's syntax tokens.
 */

/** Past this many characters code is shown plain: colouring it would stall the JS thread. */
export const SYNTAX_MAX_CHARS = 200_000;

export type SyntaxStyles = Record<SyntaxKind, TextStyle | undefined>;

function makeSyntaxStyles(colors: ThemeColors): SyntaxStyles {
  const s = StyleSheet.create({
    name: { color: colors.syntaxName },
    string: { color: colors.syntaxString },
    number: { color: colors.syntaxNumber },
    muted: { color: colors.dim },
    comment: { color: colors.syntaxComment, fontStyle: "italic" },
  });
  return {
    command: s.name,
    argument: s.string,
    flag: undefined,
    string: s.string,
    variable: s.number,
    operator: s.muted,
    comment: s.comment,
    key: s.name,
    number: s.number,
    literal: s.number,
    punct: s.muted,
    plain: undefined,
  };
}

export function useSyntaxStyles(): SyntaxStyles {
  const colors = useTheme();
  return useMemo(() => makeSyntaxStyles(colors), [colors]);
}

/** Tokens as children of an enclosing Text; uncoloured runs stay bare strings so a line isn't a pile of empty spans. */
export function TokenSpans({ tokens, styles }: { tokens: SyntaxToken[]; styles: SyntaxStyles }) {
  return (
    <>
      {tokens.map((t, i) =>
        styles[t.kind] ? (
          <Text key={i} style={styles[t.kind]}>
            {t.text}
          </Text>
        ) : (
          t.text
        ),
      )}
    </>
  );
}

/** A block of code, coloured when its language is known and it's small enough; plain otherwise. */
export const SyntaxText = memo(function SyntaxText({
  text,
  language,
  style,
}: {
  text: string;
  language: SyntaxLanguage | null;
  style?: StyleProp<TextStyle>;
}) {
  const styles = useSyntaxStyles();
  const tokens = useMemo(() => (language && text.length <= SYNTAX_MAX_CHARS ? tokenize(text, language) : null), [text, language]);
  return <Text style={style}>{tokens ? <TokenSpans tokens={tokens} styles={styles} /> : text}</Text>;
});
