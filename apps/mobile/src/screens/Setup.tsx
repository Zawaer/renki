import { decodePairing } from "@crc/client-core";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { type AppConfig, getOrCreateDeviceId } from "../lib/config";
import { colors } from "../theme";

export function Setup({ onSave }: { onSave: (config: AppConfig) => void }) {
  const [baseUrl, setBaseUrl] = useState("https://");
  const [token, setToken] = useState("");
  const [deviceName, setDeviceName] = useState("Phone");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [scanning, setScanning] = useState(false);

  async function connectWith(url: string, tok: string) {
    setError(null);
    setTesting(true);
    try {
      const cleanUrl = url.replace(/\/$/, "");
      const res = await fetch(`${cleanUrl}/repos`, { headers: { authorization: `Bearer ${tok}` } });
      if (res.status === 401) throw new Error("Token rejected (401).");
      if (!res.ok) throw new Error(`Daemon responded ${res.status}.`);
      onSave({ baseUrl: cleanUrl, token: tok, deviceId: await getOrCreateDeviceId(), deviceName });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the daemon.");
    } finally {
      setTesting(false);
    }
  }

  function onScanned(raw: string) {
    setScanning(false);
    const pairing = decodePairing(raw);
    if (!pairing) {
      setError("That QR code isn't a CRC pairing code.");
      return;
    }
    setBaseUrl(pairing.baseUrl);
    setToken(pairing.token);
    void connectWith(pairing.baseUrl, pairing.token);
  }

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.body}>
        <Text style={styles.title}>Connect to your daemon</Text>
        <Text style={styles.sub}>Scan a pairing QR from another CRC device, or enter the details manually.</Text>

        <TouchableOpacity style={styles.scanButton} onPress={() => setScanning(true)}>
          <Text style={styles.scanButtonText}>Scan QR code</Text>
        </TouchableOpacity>

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or enter manually</Text>
          <View style={styles.dividerLine} />
        </View>

        <Text style={styles.label}>Daemon URL</Text>
        <TextInput
          style={styles.input}
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://homelab.tailnet.ts.net"
          placeholderTextColor={colors.faint}
        />

        <Text style={styles.label}>Auth token</Text>
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="CRC_AUTH_TOKEN"
          placeholderTextColor={colors.faint}
        />

        <Text style={styles.label}>This device's name</Text>
        <TextInput style={styles.input} value={deviceName} onChangeText={setDeviceName} />

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity
          style={[styles.button, (!token || testing) && styles.buttonDisabled]}
          disabled={!token || testing}
          onPress={() => connectWith(baseUrl, token)}
        >
          {testing ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Connect</Text>}
        </TouchableOpacity>
      </View>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <QrScanner onScanned={onScanned} onCancel={() => setScanning(false)} />
      </Modal>
    </KeyboardAvoidingView>
  );
}

function QrScanner({ onScanned, onCancel }: { onScanned: (raw: string) => void; onCancel: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  if (!permission) return <View style={styles.fill} />;

  if (!permission.granted) {
    return (
      <View style={[styles.fill, styles.center]}>
        <Text style={styles.sub}>Camera access is needed to scan a pairing QR code.</Text>
        <TouchableOpacity style={styles.scanButton} onPress={requestPermission}>
          <Text style={styles.scanButtonText}>Grant camera access</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onCancel} style={{ marginTop: 16 }}>
          <Text style={styles.link}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={styles.fill}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return;
          handled.current = true;
          onScanned(data);
        }}
      />
      <TouchableOpacity style={styles.cancelOverlay} onPress={onCancel}>
        <Text style={styles.cancelOverlayText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  body: { flex: 1, justifyContent: "center", padding: 24, gap: 8 },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  sub: { color: colors.dim, fontSize: 13, marginBottom: 12, textAlign: "center" },
  label: { color: colors.dim, fontSize: 12, marginTop: 8 },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 15,
  },
  error: { color: colors.danger, fontSize: 13, marginTop: 8 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 16,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  scanButton: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  scanButtonText: { color: colors.accent, fontWeight: "600", fontSize: 15 },
  divider: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 12 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.faint, fontSize: 11 },
  link: { color: colors.accent, fontSize: 14 },
  cancelOverlay: {
    position: "absolute",
    bottom: 48,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  cancelOverlayText: { color: "#fff", fontWeight: "600", fontSize: 14 },
});
