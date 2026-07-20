import { encodePairing } from "@crc/client-core";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useClient } from "../lib/client";
import { colors } from "../theme";

/**
 * "Pair a device" — renders this phone's own working { baseUrl, token } as a QR
 * code so another device (a second phone, or the web app) can scan it instead
 * of typing a tailnet URL and a 43-char token by hand.
 */
export function PairDevice({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { config } = useClient();
  const payload = encodePairing({ baseUrl: config.baseUrl, token: config.token });

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Scan with another CRC device</Text>
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
  qrWrap: { padding: 12, backgroundColor: "#fff", borderRadius: 12 },
  hint: { color: colors.faint, fontSize: 11, textAlign: "center", maxWidth: 240 },
  closeBtn: { marginTop: 4, paddingHorizontal: 16, paddingVertical: 8 },
  closeBtnText: { color: colors.accent, fontSize: 14, fontWeight: "600" },
});
