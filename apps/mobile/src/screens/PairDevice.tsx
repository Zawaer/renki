import { encodePairing, isLikelyLoopbackUrl } from "@crc/client-core";
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useClient } from "../lib/client";
import { radius, softShadow, type ThemeColors, useTheme, withAlpha } from "../theme";

/**
 * "Pair a device" — renders this phone's own working { baseUrl, token } as a QR
 * code so another device (a second phone, or the web app) can scan it instead
 * of typing a tailnet URL and a 43-char token by hand.
 *
 * Two cases where this phone's own address isn't a good fit for the QR:
 *  - Loopback — means "this device," so another device scanning it would
 *    just try to reach itself.
 *  - A private-CA'd LAN hostname (e.g. Caddy's `tls internal`) — this phone
 *    may trust it (if the CA was manually installed here too), but another
 *    device's own separate trust store likely won't.
 * Rather than just fail on the other device, ask the daemon (same host, so
 * it can check its own `tailscale status`) for a real, publicly certified
 * address and offer to use it instead.
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
  const colors = useTheme();
  const styles = makeStyles(colors);
  const { config, rest } = useClient();
  const loopback = isLikelyLoopbackUrl(config.baseUrl);
  const [suggestion, setSuggestion] = useState<"loading" | "none" | string>("loading");
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // What the QR actually encodes, if different from this phone's own address —
  // set by "Use this for the QR" below, without touching this phone's own connection.
  const [qrOverride, setQrOverride] = useState<string | null>(null);

  const qrBaseUrl = qrOverride ?? config.baseUrl;
  const payload = encodePairing({ baseUrl: qrBaseUrl, token: config.token });
  const normalize = (u: string) => u.replace(/\/$/, "");
  const suggestionUsable = suggestion !== "loading" && suggestion !== "none";
  const suggestionDiffers = suggestionUsable && normalize(suggestion) !== normalize(config.baseUrl);

  useEffect(() => {
    if (!visible) return;
    setSuggestion("loading");
    setQrOverride(null);
    rest
      .getTailscaleStatus()
      .then((s) => {
        if (!s.available || !s.hostname || !s.servePort) return setSuggestion("none");
        setSuggestion(`https://${s.hostname}${s.servePort === 443 ? "" : `:${s.servePort}`}`);
      })
      .catch(() => setSuggestion("none"));
  }, [visible, rest]);

  async function reconnectUsing(url: string) {
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
              {suggestionUsable && (
                <>
                  <Text style={styles.warning}>Detected: {suggestion}</Text>
                  <TouchableOpacity
                    style={styles.suggestBtn}
                    disabled={switching}
                    onPress={() => reconnectUsing(suggestion)}
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
          {!loopback && suggestionDiffers && (
            <View style={styles.suggestBox}>
              {qrOverride ? (
                <>
                  <Text style={styles.suggestText}>
                    This QR now points at {qrOverride} instead of {config.baseUrl} — this phone's own
                    connection is unaffected.
                  </Text>
                  <TouchableOpacity style={styles.suggestBtnNeutral} onPress={() => setQrOverride(null)}>
                    <Text style={styles.suggestBtnNeutralText}>Use {config.baseUrl} instead</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={styles.suggestText}>
                    Pairing a device that won't trust {config.baseUrl}'s certificate (common on Android, if
                    that address goes through a reverse proxy's own private CA)? Use the Tailscale address
                    instead — no certificate to install: {suggestion}
                  </Text>
                  <TouchableOpacity style={styles.suggestBtnNeutral} onPress={() => setQrOverride(suggestion)}>
                    <Text style={styles.suggestBtnNeutralText}>Use this for the QR</Text>
                  </TouchableOpacity>
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

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.65)", alignItems: "center", justifyContent: "center" },
  card: {
    backgroundColor: colors.panel,
    borderRadius: radius.lg,
    padding: 24,
    alignItems: "center",
    gap: 12,
    ...softShadow(colors),
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  warningBox: {
    maxWidth: 260,
    gap: 6,
    backgroundColor: withAlpha(colors.busy, 0.14),
    borderRadius: radius.md,
    padding: 10,
  },
  warning: { color: colors.busy, fontSize: 11, lineHeight: 15, textAlign: "center" },
  suggestBtn: { backgroundColor: withAlpha(colors.busy, 0.3), borderRadius: radius.pill, paddingVertical: 8, alignItems: "center" },
  suggestBtnText: { color: colors.busy, fontSize: 12, fontWeight: "600" },
  suggestBox: {
    maxWidth: 260,
    gap: 6,
    backgroundColor: colors.panel2,
    borderRadius: radius.md,
    padding: 10,
  },
  suggestText: { color: colors.dim, fontSize: 11, lineHeight: 15, textAlign: "center" },
  suggestBtnNeutral: { backgroundColor: colors.panel2, borderRadius: radius.pill, paddingVertical: 8, alignItems: "center" },
  suggestBtnNeutralText: { color: colors.text, fontSize: 12, fontWeight: "600" },
  qrWrap: { padding: 14, backgroundColor: "#fff", borderRadius: radius.md },
  hint: { color: colors.faint, fontSize: 11, textAlign: "center", maxWidth: 240 },
  closeBtn: { marginTop: 4, paddingHorizontal: 16, paddingVertical: 8 },
  closeBtnText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
});
