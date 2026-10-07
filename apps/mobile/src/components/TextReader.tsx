import { Ionicons } from "@expo/vector-icons";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type ThemeColors, useTheme } from "../theme";

/**
 * Long-press a message to read it in a plain full-screen view, where its text
 * selects and copies like any Android text.
 *
 * Why not just make the chat's own Text selectable: the transcript is an
 * inverted FlatList, and on Android selectable text there misbehaves both
 * ways round — tapping it focuses the TextView, which scrolls the (flipped)
 * list to "reveal" it and jumps the view; and the selection handles don't
 * come up properly inside the flipped transform. Here the text sits in an
 * ordinary ScrollView, so selection works, and Share reaches the system
 * sheet's Copy without a native clipboard module.
 */
type Reading = { title: string; text: string };

const ReaderContext = createContext<(reading: Reading) => void>(() => {});

export function TextReaderProvider({ children }: { children: React.ReactNode }) {
  const [reading, setReading] = useState<Reading | null>(null);
  const open = useCallback((r: Reading) => setReading(r), []);
  return (
    <ReaderContext.Provider value={open}>
      {children}
      <TextReader reading={reading} onClose={() => setReading(null)} />
    </ReaderContext.Provider>
  );
}

/** Wraps a message so a long-press opens it in the reader. Taps and scrolling pass through untouched. */
export function LongPressToRead({
  title,
  text,
  style,
  children,
}: {
  title: string;
  text: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const open = useContext(ReaderContext);
  if (!text.trim()) return <View style={style}>{children}</View>;
  return (
    <Pressable style={style} delayLongPress={350} onLongPress={() => open({ title, text })}>
      {children}
    </Pressable>
  );
}

function TextReader({ reading, onClose }: { reading: Reading | null; onClose: () => void }) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Modal visible={reading != null} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>
            {reading?.title}
          </Text>
          <TouchableOpacity
            onPress={() => reading && void Share.share({ message: reading.text })}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Share or copy all"
          >
            <Ionicons name="share-outline" size={22} color={colors.text} />
          </TouchableOpacity>
        </View>
        <Text style={styles.hint}>Press and hold to select. Share has Copy for all of it.</Text>
        <ScrollView contentContainerStyle={styles.body}>
          <Text selectable style={styles.text}>
            {reading?.text}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16, paddingVertical: 12 },
    title: { flex: 1, color: colors.text, fontSize: 17, fontWeight: "600" },
    hint: { color: colors.faint, fontSize: 12.5, paddingHorizontal: 16, paddingBottom: 8 },
    body: { paddingHorizontal: 16, paddingBottom: 32 },
    text: { color: colors.text, fontSize: 16, lineHeight: 24 },
  });
}
