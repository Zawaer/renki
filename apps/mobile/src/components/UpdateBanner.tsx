import { Ionicons } from "@expo/vector-icons";
import * as Updates from "expo-updates";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, type ThemeColors, useTheme } from "../theme";
import { FadeIn } from "./Motion";

/**
 * Says when a new version is on its way and when it's ready, with a button to
 * start it. Without it an over-the-air update just happened at some launch,
 * silently, and there was no telling how long to keep the app open for it or
 * whether it had arrived.
 *
 * Reads expo-updates' own state, so an update the app fetched by itself at
 * launch shows as ready too, not only one this asked for. Asks again whenever
 * the app comes back to the front.
 */
export function UpdateBanner() {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { isDownloading, isUpdatePending, downloadError } = Updates.useUpdates();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Development builds and Expo Go have no update channel.
    if (__DEV__ || !Updates.isEnabled) return;
    const check = () =>
      Updates.checkForUpdateAsync()
        .then((found) => (found.isAvailable ? Updates.fetchUpdateAsync() : null))
        .catch(() => {
          // Offline, most likely: downloadError says so if a download had started.
        });
    void check();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    return () => sub.remove();
  }, []);

  const phase = isUpdatePending ? "ready" : isDownloading ? "downloading" : downloadError ? "failed" : null;
  if (!phase || dismissed) return null;
  return (
    <FadeIn style={[styles.wrap, { top: insets.top + 8 }]} pointerEvents="box-none">
      <View style={styles.banner}>
        {phase === "downloading" && (
          <>
            <ActivityIndicator size="small" color={colors.dim} />
            <Text style={styles.text}>Downloading an update…</Text>
          </>
        )}
        {phase === "ready" && (
          <>
            <Ionicons name="sparkles-outline" size={18} color={colors.accent} />
            <Text style={styles.text}>Update ready</Text>
            <TouchableOpacity onPress={() => setDismissed(true)} hitSlop={8}>
              <Text style={styles.later}>Later</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.restart} onPress={() => void Updates.reloadAsync()}>
              <Text style={styles.restartText}>Restart</Text>
            </TouchableOpacity>
          </>
        )}
        {phase === "failed" && (
          <>
            <Ionicons name="cloud-offline-outline" size={18} color={colors.dim} />
            <Text style={styles.text}>The update didn't download. It tries again next time.</Text>
            <TouchableOpacity onPress={() => setDismissed(true)} hitSlop={8}>
              <Ionicons name="close" size={18} color={colors.dim} />
            </TouchableOpacity>
          </>
        )}
      </View>
    </FadeIn>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { position: "absolute", left: 14, right: 14, alignItems: "center", zIndex: 100 },
    banner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.panel,
      borderRadius: radius.pill,
      paddingLeft: 16,
      paddingRight: 8,
      paddingVertical: 8,
      minHeight: 48,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    text: { flexShrink: 1, color: colors.text, fontSize: 14 },
    later: { color: colors.dim, fontSize: 14, paddingHorizontal: 4 },
    restart: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 7 },
    restartText: { color: colors.accentFg, fontSize: 14, fontWeight: "700" },
  });
}
