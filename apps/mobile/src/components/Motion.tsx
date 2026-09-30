import { useEffect, useRef } from "react";
import { Animated, Easing, LayoutAnimation, Platform, type StyleProp, UIManager, type ViewStyle } from "react-native";
import { useTheme, withAlpha } from "../theme";

/**
 * The app's one motion vocabulary. Everything that appears, changes screen or
 * expands uses these durations and this curve, so the app moves as one thing
 * rather than each part popping in its own way. All on the native driver
 * (opacity and transform only), so a busy JS thread can't make it stutter.
 */
export const MOTION = {
  /** Things appearing: rows, banners, content replacing a skeleton. */
  enter: 220,
  /** A whole screen sliding in. */
  screen: 260,
  /** Expanding or collapsing a disclosure. */
  layout: 180,
  easing: Easing.bezier(0.2, 0.8, 0.2, 1),
} as const;

// Old-architecture Android needs this for LayoutAnimation; on the new one it's a no-op.
if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * Call right before a state change that grows or shrinks something — opening
 * a tool step, a group, a file's diff — so the rows around it glide to their
 * new place instead of jumping.
 */
export function animateLayout(): void {
  LayoutAnimation.configureNext({
    duration: MOTION.layout,
    create: { type: "easeInEaseOut", property: "opacity" },
    update: { type: "easeInEaseOut" },
    delete: { type: "easeInEaseOut", property: "opacity" },
  });
}

/**
 * Fades its children in as it mounts, rising a few points from below. Pass
 * `enabled={false}` for content that was already on screen, so only genuinely
 * new things move.
 */
export function FadeIn({
  children,
  enabled = true,
  delay = 0,
  distance = 6,
  style,
  pointerEvents,
}: {
  children: React.ReactNode;
  enabled?: boolean;
  delay?: number;
  distance?: number;
  style?: StyleProp<ViewStyle>;
  pointerEvents?: "box-none" | "none" | "box-only" | "auto";
}) {
  const progress = useRef(new Animated.Value(enabled ? 0 : 1)).current;
  useEffect(() => {
    if (!enabled) return;
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration: MOTION.enter,
      delay,
      easing: MOTION.easing,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
    // Mount-only on purpose: re-rendering must never replay the entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] });
  return (
    <Animated.View pointerEvents={pointerEvents} style={[style, { opacity: progress, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

/**
 * A screen's entrance: pushed screens slide in from the right, going back
 * slides the previous one in from the left — the direction says which way
 * you moved, the way every native app does it.
 */
export function Screen({ children, direction }: { children: React.ReactNode; direction: "push" | "pop" }) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(progress, { toValue: 1, duration: MOTION.screen, easing: MOTION.easing, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [progress]);
  const from = direction === "push" ? 28 : -28;
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [from, 0] });
  const opacity = progress.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] });
  return <Animated.View style={{ flex: 1, opacity, transform: [{ translateX }] }}>{children}</Animated.View>;
}

/**
 * One shared shimmer for every skeleton on screen, so placeholders pulse in
 * step instead of each on its own clock.
 */
const shimmer = new Animated.Value(0);
let shimmerUsers = 0;
let shimmerLoop: Animated.CompositeAnimation | null = null;

function useShimmer(): Animated.Value {
  useEffect(() => {
    shimmerUsers += 1;
    if (!shimmerLoop) {
      shimmerLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(shimmer, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(shimmer, { toValue: 0, duration: 800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
      );
      shimmerLoop.start();
    }
    return () => {
      shimmerUsers -= 1;
      if (shimmerUsers === 0) {
        shimmerLoop?.stop();
        shimmerLoop = null;
      }
    };
  }, []);
  return shimmer;
}

/** A placeholder block where content will be: the shape of what's coming, not a spinner. */
export function Skeleton({ width, height, radius = 8, style }: { width: number | `${number}%`; height: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const colors = useTheme();
  const value = useShimmer();
  const opacity = value.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.9] });
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: withAlpha(colors.text, 0.08), opacity }, style]} />;
}
