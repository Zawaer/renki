import { UNREACHABLE_AFTER_MS, describeUnreachable } from "@renki/client-core";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useClient, useStoreValue } from "../lib/client";
import { radius, useTheme, withAlpha } from "../theme";
import { FadeIn } from "./Motion";

/**
 * "Can't reach your Renki host" — floats over whatever screen is showing
 * once the live connection has been down for a while, so an empty chat list
 * or a frozen chat explains itself. Waits UNREACHABLE_AFTER_MS first (a
 * network switch or waking the phone reconnects in seconds), and goes the
 * moment the connection is back.
 */
export function ConnectionBanner() {
  const { realtime, config } = useClient();
  const status = useStoreValue(realtime.status);
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const [down, setDown] = useState(false);

  useEffect(() => {
    if (status === "open") {
      setDown(false);
      return;
    }
    const t = setTimeout(() => setDown(true), UNREACHABLE_AFTER_MS);
    return () => clearTimeout(t);
  }, [status]);

  if (!down || status === "open") return null;
  const { title, body } = describeUnreachable(config.baseUrl);
  return (
    <FadeIn style={[styles.wrap, { top: insets.top + 8 }]} pointerEvents="box-none">
      <View
        accessibilityRole="alert"
        style={[styles.card, { backgroundColor: colors.panel, borderColor: withAlpha(colors.busy, 0.35) }]}
      >
        <Ionicons name="cloud-offline-outline" size={20} color={colors.busy} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          <Text style={[styles.body, { color: colors.dim }]}>{body}</Text>
        </View>
        <TouchableOpacity style={[styles.btn, { backgroundColor: colors.accent }]} onPress={() => realtime.reconnect()}>
          <Text style={[styles.btnText, { color: colors.accentFg }]}>{status === "connecting" ? "…" : "Retry"}</Text>
        </TouchableOpacity>
      </View>
    </FadeIn>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 12, right: 12, zIndex: 50 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    elevation: 6,
  },
  title: { fontSize: 14, fontWeight: "600" },
  body: { fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  btn: { borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 7 },
  btnText: { fontSize: 13, fontWeight: "700" },
});
