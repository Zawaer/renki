import { Ionicons } from "@expo/vector-icons";
import { useMemo, useRef } from "react";
import { Animated, Modal, PanResponder, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { radius, type ThemeColors } from "../theme";

const DISMISS_DISTANCE = 90;
const DISMISS_VELOCITY = 0.8;
const CLOSE_ANIM_MS = 180;

/**
 * Shared bottom-sheet chrome (drag handle + X close + centered title) used by
 * every mobile bottom sheet — model/effort/mode pickers, the attach menu, the
 * session actions sheet. Swipe-to-dismiss lives on the handle/title row only,
 * not the scrollable body below it, so a sheet with a long list still scrolls
 * normally instead of fighting the dismiss gesture.
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
  const translateY = useRef(new Animated.Value(0)).current;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_, gesture) => {
          if (gesture.dy > 0) translateY.setValue(gesture.dy);
        },
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > DISMISS_DISTANCE || gesture.vy > DISMISS_VELOCITY) {
            Animated.timing(translateY, { toValue: 800, duration: CLOSE_ANIM_MS, useNativeDriver: true }).start(() => {
              translateY.setValue(0);
              onClose();
            });
          } else {
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
        },
      }),
    [translateY, onClose],
  );

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1}>
          <Animated.View style={[styles.sheet, { backgroundColor: colors.panel, transform: [{ translateY }] }]}>
            <View {...panResponder.panHandlers}>
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
            </View>
            {children}
          </Animated.View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, paddingBottom: 28, maxHeight: "80%" },
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginTop: 10, marginBottom: 4 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingVertical: 14 },
  titleText: { fontSize: 17, fontWeight: "700" },
  titleSpacer: { width: 20 },
});
