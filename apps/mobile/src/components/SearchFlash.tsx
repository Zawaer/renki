import { createContext, useContext, useEffect, useRef } from "react";
import { Animated, type StyleProp, Text, type TextStyle, type View } from "react-native";
import { MOTION } from "./Motion";
import { radius, useTheme, withAlpha } from "../theme";

/**
 * Where a search hit landed in the open chat: the anchor to mark (the same
 * `p:<promptId>` / `b:<turnId>:<block>` / `t:<turnId>` values the web puts in
 * `data-anchor`), the query to highlight in it, and who to tell where it ended
 * up on screen so the list can bring it to the middle.
 */
export type SearchFlashTarget = {
  anchor: string;
  query: string;
  /** Called once the marked view is laid out, with its place in the window. */
  onPlaced: (y: number, height: number) => void;
};

export const SearchFlashContext = createContext<SearchFlashTarget | null>(null);

/** How long the tint stays before fading out. */
const HOLD_MS = 900;
const FADE_OUT_MS = 700;

/**
 * A tint over its parent that fades in and out once when the parent is the
 * search hit, and renders nothing otherwise. Goes last inside the view it
 * marks, so adding it never remounts what's already there.
 */
export function SearchFlash({ anchor, inset = -6, rounding = radius.md }: { anchor: string; inset?: number; rounding?: number }) {
  const flash = useContext(SearchFlashContext);
  if (flash?.anchor !== anchor) return null;
  return <Tint flash={flash} inset={inset} rounding={rounding} />;
}

/** Played once per jump: a row that scrolls away and back while it's still set doesn't flash again. */
const played = new WeakSet<SearchFlashTarget>();

function Tint({ flash, inset, rounding }: { flash: SearchFlashTarget; inset: number; rounding: number }) {
  const colors = useTheme();
  const ref = useRef<View>(null);
  const first = !played.has(flash);
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!first) return;
    played.add(flash);
    // Give the list a moment to land on the row before measuring where it is.
    const t = setTimeout(() => ref.current?.measureInWindow((_x, y, _w, h) => flash.onPlaced(y, h)), 120);
    const anim = Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: MOTION.enter, easing: MOTION.easing, useNativeDriver: true }),
      Animated.delay(HOLD_MS),
      Animated.timing(opacity, { toValue: 0, duration: FADE_OUT_MS, easing: MOTION.easing, useNativeDriver: true }),
    ]);
    anim.start();
    return () => {
      clearTimeout(t);
      anim.stop();
    };
    // Once per jump, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Animated.View
      ref={ref}
      pointerEvents="none"
      style={{
        position: "absolute",
        top: inset,
        bottom: inset,
        left: inset,
        right: inset,
        borderRadius: rounding,
        backgroundColor: withAlpha(colors.accent, 0.18),
        opacity,
      }}
    />
  );
}

/**
 * Plain text with every occurrence of the query marked while `anchor` is the
 * hit, like the web's highlight. Markdown replies only get the tint.
 */
export function SearchMatchText({ text, anchor, style }: { text: string; anchor: string; style?: StyleProp<TextStyle> }) {
  const flash = useContext(SearchFlashContext);
  const colors = useTheme();
  const q = flash?.anchor === anchor ? flash.query.trim().toLowerCase() : "";
  if (!q) return <Text style={style}>{text}</Text>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + q.length)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <Text key={at} style={{ backgroundColor: withAlpha(colors.accent, 0.3) }}>
        {text.slice(at, at + q.length)}
      </Text>,
    );
    from = at + q.length;
  }
  parts.push(text.slice(from));
  return <Text style={style}>{parts}</Text>;
}
