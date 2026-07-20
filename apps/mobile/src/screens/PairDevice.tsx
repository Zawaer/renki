import { encodePairing, isLikelyLoopbackUrl } from "@crc/client-core";
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useClient } from "../lib/client";
import { colors } from "../theme";

/**
 * "Pair a device" — renders this phone's own working { baseUrl, token } as a QR
 * code so another device (a second phone, or the web app) can scan it instead
 * of typing a tailnet URL and a 43-char token by hand.
 *
 * If THIS phone is only reachable via a loopback address, the QR would tell
 * another device to reach itself, which fails. Rather than just warn, ask the
 * daemon (same host, so it can check its own `tailscale status`) for a real
 * address and offer to switch to it in one tap.
 */
export function PairDevice({
  visible,
  onClose,
  onReconnect,
}: {
  visible: boolean;
  onClose: () => void;
  onReconnect: (baseUrl: string) => Promise<void>;
}) {
  const { config, rest } = useClient();
  const payload = encodePairing({ baseUrl: config.baseUrl, token: config.token });
  const loopback = isLikelyLoopbackUrl(config.baseUrl);
  const [suggestion, setSuggestion] = useState<"loading" | "none" | string>("loading");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !loopback) return;
    setSuggestion("loading");
    rest
      .getTailscaleStatus()
      .then((s) => setSuggestion(s.available && s.hostname ? `https://${s.hostname}` : "none"))
      .catch(() => setSuggestion("none"));
  }, [visible, loopback, rest]);

  async function useSuggestion(url: string) {
    setSwitching(true);
    setSwitchError(null);
    try {
      const res = await fetch(`${url}/repos`, { headers: { authorization: `Bearer ${config.token}` } });
      if (!res.ok) throw new Error(`Daemon responded ${res.status}`);
      await onReconnect(url);
      onClose();
    } catch {
      setSwitchError(`Could not reach ${url}. Make sure "tailscale serve --bg <port>" is running on the daemon host.`);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Scan with another CRC device</Text>
          {loopback && (
            <View style={styles.warningBox}>
              <Text style={styles.warning}>
                This phone is connected via {config.baseUrl} — a loopback address that only means "this
                device." Another device scanning this QR would try to reach itself and fail.
              </Text>
              {suggestion === "loading" && <ActivityIndicator color={colors.busy} style={{ marginTop: 6 }} />}
              {suggestion === "none" && (
                <Text style={styles.warning}>
                  Couldn't detect a Tailscale address on the daemon host. Reconnect this phone using its
                  tailnet URL manually, then show the QR again.
                </Text>
              )}
              {suggestion !== "loading" && suggestion !== "none" && (
                <>
                  <Text style={styles.warning}>Detected: {suggestion}</Text>
                  <TouchableOpacity
                    style={styles.suggestBtn}
                    disabled={switching}
                    onPress={() => useSuggestion(suggestion)}
                  >
                    <Text style={styles.suggestBtnText}>
                      {switching ? "Reconnecting…" : "Reconnect using this address"}
                    </Text>
                  </TouchableOpacity>
                  {switchError && <Text style={styles.warning}>{switchError}</Text>}
                </>
              )}
            </View>
          )}
          <View style={styles.qrWrap}>
            <QRCode value={payload} size={240} backgroundColor="#fff" />
          </View>
          <Text style={styles.hint}>Setup → Scan QR. Grants the same access this phone has.</Text>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center" },
  card: {
    backgroundColor: colors.panel,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { color: colors.text, fontSize: 15, fontWeight: "600" },
  warningBox: {
    maxWidth: 260,
    gap: 6,
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    borderRadius: 8,
    padding: 8,
  },
  warning: { color: colors.busy, fontSize: 11, lineHeight: 15, textAlign: "center" },
  suggestBtn: { backgroundColor: "rgba(245, 158, 11, 0.25)", borderRadius: 6, paddingVertical: 6, alignItems: "center" },
  suggestBtnText: { color: colors.busy, fontSize: 12, fontWeight: "600" },
  qrWrap: { padding: 12, backgroundColor: "#fff", borderRadius: 12 },
  hint: { color: colors.faint, fontSize: 11, textAlign: "center", maxWidth: 240 },
  closeBtn: { marginTop: 4, paddingHorizontal: 16, paddingVertical: 8 },
  closeBtnText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
});
