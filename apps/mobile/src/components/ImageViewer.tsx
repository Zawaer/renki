import { attachmentSource, type Attachment } from "@renki/client-core";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, FlatList, type GestureResponderEvent, Modal, PanResponder, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useClient } from "../lib/client";
import { MOTION } from "./Motion";
import { ModalFrame } from "./ModalFrame";

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 260;
/** Further than this and a touch is a drag, not a tap. */
const TAP_SLOP = 8;

/**
 * Full-screen viewer over every image of one message (or tool result),
 * opening on the one tapped: swipe between them, double-tap or pinch to zoom,
 * drag to look around a zoomed one. Tap, the close button or Android back
 * closes it. Plain PanResponder and Animated, so no native gesture library.
 */
export function ImageViewer({ images, index, onClose }: { images: Attachment[]; index: number | null; onClose: () => void }) {
  const visible = index != null && images.length > 0;
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <ModalFrame>{visible && <Pager images={images} start={Math.min(index, images.length - 1)} onClose={onClose} />}</ModalFrame>
    </Modal>
  );
}

function Pager({ images, start, onClose }: { images: Attachment[]; start: number; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [page, setPage] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  return (
    <View style={styles.backdrop} onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
      {size && (
        <FlatList
          data={images}
          horizontal
          pagingEnabled
          initialScrollIndex={start}
          getItemLayout={(_, i) => ({ length: size.width, offset: size.width * i, index: i })}
          keyExtractor={(_, i) => String(i)}
          showsHorizontalScrollIndicator={false}
          // A zoomed image takes every drag for itself; zoom back out to swipe on.
          scrollEnabled={!zoomed && images.length > 1}
          onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / size.width))}
          windowSize={3}
          initialNumToRender={1}
          renderItem={({ item, index }) => (
            <ZoomableImage image={item} width={size.width} height={size.height} active={index === page} onZoomChange={setZoomed} onTap={onClose} />
          )}
        />
      )}
      {images.length > 1 && (
        <View style={[styles.counter, { top: insets.top + 14 }]} pointerEvents="none">
          <Text style={styles.counterText}>
            {page + 1} / {images.length}
          </Text>
        </View>
      )}
      <TouchableOpacity
        style={[styles.close, { top: insets.top + 10 }]}
        onPress={onClose}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Ionicons name="close" size={26} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

/**
 * One page. The transform is translate-then-scale about the page's centre,
 * so a point p shows at C + t + s(p − C); every gesture below solves that
 * for t to keep the spot under your fingers where it was.
 */
function ZoomableImage({
  image,
  width,
  height,
  active,
  onZoomChange,
  onTap,
}: {
  image: Attachment;
  width: number;
  height: number;
  /** The page on screen; one swiped away resets to fit. */
  active: boolean;
  onZoomChange: (zoomed: boolean) => void;
  onTap: () => void;
}) {
  const { config } = useClient();
  const [aspect, setAspect] = useState(width / height);
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  /** Where the transform is now, mirrored for the gesture maths. */
  const cur = useRef({ s: 1, x: 0, y: 0 });
  /** The gesture in progress: the transform it started from and the touch(es) it's measured against. */
  const g = useRef({ mode: "pan" as "pan" | "pinch", s0: 1, x0: 0, y0: 0, d0: 1, fx: 0, fy: 0, px: 0, py: 0, moved: false, lastTap: 0 });
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The latest of these for the responder, which is built once.
  const latest = useRef({ width, height, aspect, onZoomChange, onTap });
  latest.current = { width, height, aspect, onZoomChange, onTap };

  /** How far the scaled image can move before an edge comes away from the screen's. */
  function bounds(s: number) {
    const { width: w, height: h, aspect: a } = latest.current;
    const fitW = w / h > a ? h * a : w;
    const fitH = w / h > a ? h : w / a;
    return { x: Math.max(0, (fitW * s - w) / 2), y: Math.max(0, (fitH * s - h) / 2) };
  }

  function set(s: number, x: number, y: number) {
    cur.current = { s, x, y };
    scale.setValue(s);
    tx.setValue(x);
    ty.setValue(y);
  }

  /** Eases to a resting place: scale within limits, edges inside the screen, fully out means centred. */
  function settle(s: number, x: number, y: number, animated = true) {
    const ns = Math.min(MAX_SCALE, Math.max(1, s));
    const b = bounds(ns);
    const nx = ns === 1 ? 0 : Math.min(b.x, Math.max(-b.x, x));
    const ny = ns === 1 ? 0 : Math.min(b.y, Math.max(-b.y, y));
    cur.current = { s: ns, x: nx, y: ny };
    latest.current.onZoomChange(ns > 1);
    if (!animated) return set(ns, nx, ny);
    const to = (v: Animated.Value, toValue: number) =>
      Animated.timing(v, { toValue, duration: MOTION.enter, easing: MOTION.easing, useNativeDriver: true });
    Animated.parallel([to(scale, ns), to(tx, nx), to(ty, ny)]).start();
  }

  /** Starts measuring from the touches down now, so adding or lifting a finger doesn't jump. */
  function begin(e: GestureResponderEvent) {
    const touches = e.nativeEvent.touches;
    const st = g.current;
    st.s0 = cur.current.s;
    st.x0 = cur.current.x;
    st.y0 = cur.current.y;
    if (touches.length >= 2) {
      const [a, b] = [touches[0]!, touches[1]!];
      st.mode = "pinch";
      st.moved = true;
      st.d0 = Math.max(1, Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY));
      st.fx = (a.pageX + b.pageX) / 2;
      st.fy = (a.pageY + b.pageY) / 2;
      latest.current.onZoomChange(true); // stop the pager from taking the pinch as a swipe
    } else if (touches.length === 1) {
      st.mode = "pan";
      st.px = touches[0]!.pageX;
      st.py = touches[0]!.pageY;
    }
  }

  function tap(x: number, y: number) {
    const st = g.current;
    const now = Date.now();
    if (now - st.lastTap < DOUBLE_TAP_MS) {
      clearTimeout(tapTimer.current);
      st.lastTap = 0;
      if (cur.current.s > 1) return settle(1, 0, 0);
      const { width: w, height: h } = latest.current;
      const s = DOUBLE_TAP_SCALE;
      return settle(s, (x - w / 2) * (1 - s), (y - h / 2) * (1 - s));
    }
    st.lastTap = now;
    // A single tap closes, as it always has, once it's clearly not the first of two.
    tapTimer.current = setTimeout(() => {
      if (cur.current.s === 1) latest.current.onTap();
    }, DOUBLE_TAP_MS);
  }

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Zoomed, drags are ours; at fit size the pager may take a swipe from us.
        onShouldBlockNativeResponder: () => cur.current.s > 1,
        onPanResponderTerminationRequest: () => cur.current.s === 1 && g.current.mode === "pan",
        onPanResponderGrant: (e) => {
          g.current.moved = false;
          begin(e);
        },
        onPanResponderStart: begin,
        onPanResponderEnd: (e) => {
          if (e.nativeEvent.touches.length > 0) begin(e);
        },
        onPanResponderMove: (e) => {
          const touches = e.nativeEvent.touches;
          const st = g.current;
          const { width: w, height: h } = latest.current;
          if (st.mode === "pinch" && touches.length >= 2) {
            const [a, b] = [touches[0]!, touches[1]!];
            const ratio = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) / st.d0;
            // A little give past the limits while the fingers are down; settle() brings it back.
            const s = Math.min(MAX_SCALE * 1.2, Math.max(0.8, st.s0 * ratio));
            const mx = (a.pageX + b.pageX) / 2;
            const my = (a.pageY + b.pageY) / 2;
            const k = s / st.s0;
            set(s, mx - w / 2 - k * (st.fx - w / 2 - st.x0), my - h / 2 - k * (st.fy - h / 2 - st.y0));
          } else if (st.mode === "pan" && touches.length === 1) {
            const dx = touches[0]!.pageX - st.px;
            const dy = touches[0]!.pageY - st.py;
            if (Math.abs(dx) + Math.abs(dy) > TAP_SLOP) st.moved = true;
            if (cur.current.s > 1) set(cur.current.s, st.x0 + dx, st.y0 + dy);
          }
        },
        onPanResponderRelease: (e) => {
          const st = g.current;
          if (!st.moved) tap(e.nativeEvent.pageX, e.nativeEvent.pageY);
          settle(cur.current.s, cur.current.x, cur.current.y);
        },
        onPanResponderTerminate: () => settle(cur.current.s, cur.current.x, cur.current.y),
      }),
    // Built once; everything it reads goes through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Swiped away: the next visit starts at fit size.
  useEffect(() => {
    if (!active && cur.current.s !== 1) settle(1, 0, 0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  useEffect(() => () => clearTimeout(tapTimer.current), []);

  return (
    <View style={{ width, height, overflow: "hidden" }} {...responder.panHandlers}>
      <Animated.Image
        source={attachmentSource(image, config)}
        style={[styles.image, { transform: [{ translateX: tx }, { translateY: ty }, { scale }] }]}
        resizeMode="contain"
        accessibilityLabel={image.name}
        onLoad={(e) => {
          const { width: w, height: h } = e.nativeEvent.source;
          if (w > 0 && h > 0) setAspect(w / h);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)" },
  image: { flex: 1, width: "100%" },
  counter: { position: "absolute", alignSelf: "center", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, backgroundColor: "rgba(0,0,0,0.45)" },
  counterText: { color: "#fff", fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  close: { position: "absolute", right: 20 },
});
