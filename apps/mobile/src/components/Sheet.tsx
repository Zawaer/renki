import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Modal, PanResponder, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { radius, type ThemeColors } from "../theme";

const DISMISS_DISTANCE = 90;
const DISMISS_VELOCITY = 0.8;
/** Comfortably past any screen height, so "closed" is always fully off-screen regardless of device size. */
const OFFSCREEN_Y = 1000;

/**
 * Shared bottom-sheet chrome (drag handle + X close + centered title) used by
 * every mobile bottom sheet — model/effort/mode pickers, the attach menu, the
 * session actions sheet.
 *
 * Two animations run independently, both driven from here rather than from
 * `Modal`'s own `animationType` (which would tie the backdrop's fade to the
 * same transform as the sheet's slide): a fade on `backdropOpacity` and a
 * slide on `translateY`. Every way of closing (drag release past threshold,
 * the X button, tapping the backdrop, Android back) goes through the same
 * path — call `onClose`, which flips the `visible` prop, which this
 * component reacts to by animating both to their closed values and only
 * THEN unmounting the Modal (`mounted` state) — so nothing ever snaps back
 * to the open position first: an earlier version reset `translateY` to 0
 * synchronously right before hiding, which native-drove the value back to
 * "open" a frame or two before React's state update actually hid the Modal,
 * reading as a flash back open followed by the Modal's own close.
 *
 * The pan responder is attached directly to the sheet's own outer surface
 * (not nested under a swallow-taps TouchableOpacity) and claims every touch
 * on the sheet immediately via `onStartShouldSetPanResponder`. That's
 * deliberate: an ancestor Touchable claiming the responder at touch-down (as
 * a `<TouchableOpacity activeOpacity={1}>` swallow wrapper would) blocks a
 * nested PanResponder's `onMoveShouldSetPanResponder` from ever getting
 * asked, since RN only re-negotiates the responder for a NEW touch, not
 * mid-gesture. Claiming here instead still lets deeper children (rows, the X
 * button, the body ScrollView) win the responder first for their own
 * taps/scrolls, since RN asks the deepest view under the touch before it
 * ever asks this one.
 */
export function Sheet({
  visible,
  onClose,
  title,
  colors,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  colors: ThemeColors;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(visible);
  const translateY = useRef(new Animated.Value(visible ? 0 : OFFSCREEN_Y)).current;
  const backdropOpacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  // Callers pass a fresh `() => setXOpen(false)` every render; keeping the
  // latest one in a ref (rather than in the PanResponder's own deps) means
  // the responder — and all five of its gesture-callback closures — is built
  // once per mount instead of reconstructed on every re-render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(backdropOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(backdropOpacity, { toValue: 0, duration: 160, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: OFFSCREEN_Y, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, translateY, backdropOpacity]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Deliberately NOT claiming on touch-start (`onStartShouldSetPanResponder`):
        // that would win the responder race against a tapped row/the X button
        // (whichever is deeper gets asked first, but once *this* claims at
        // start, RN can still hand it off mid-gesture on the next move, which
        // silently ate row taps). Only claiming once real vertical movement is
        // seen means a plain tap never gets reassigned away from its row.
        onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_, gesture) => {
          if (gesture.dy > 0) translateY.setValue(gesture.dy);
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > DISMISS_DISTANCE || gesture.vy > DISMISS_VELOCITY) {
            onCloseRef.current(); // flips `visible` false — the effect above animates translateY/backdropOpacity the rest of the way
          } else {
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        },
      }),
    [translateY],
  );

  if (!mounted) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <View style={styles.backdropFill}>
        <Animated.View style={[styles.scrim, { opacity: backdropOpacity }]} />
        <TouchableOpacity style={styles.backdropTap} activeOpacity={1} onPress={onClose} />
        <Animated.View
          style={[styles.sheet, { backgroundColor: colors.panel, transform: [{ translateY }] }]}
          {...panResponder.panHandlers}
        >
          <View style={[styles.handle, { backgroundColor: colors.border }]} />
          <View style={styles.titleRow}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={20} color={colors.text} />
            </TouchableOpacity>
            <Text style={[styles.titleText, { color: colors.text }]} numberOfLines={1}>
              {title}
            </Text>
            <View style={styles.titleSpacer} />
          </View>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // Absolutely filled (rather than relying on flex inside the Modal's own
  // root) so the scrim always covers the true screen bottom — including any
  // gesture-nav inset — with no gap where the screen behind could show
  // through under the sheet.
  backdropFill: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  backdropTap: { ...StyleSheet.absoluteFillObject },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingBottom: 40,
    maxHeight: "80%",
  },
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginTop: 10, marginBottom: 4 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingVertical: 14 },
  titleText: { fontSize: 17, fontWeight: "700" },
  titleSpacer: { width: 20 },
});
