import { decodePairing, describeConnectionError } from "@renki/client-core";
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
import { radius, type ThemeColors, useTheme } from "../theme";

/**
 * Point a client at a daemon and enter its token — used both for first-run
 * onboarding (full screen, no way to cancel) and for adding a second host to
 * switch between (a modal, with a Cancel link).
 *
 * `label` is the second thing add-host mode collects beyond `AppConfig`:
 * what this host is called in the switcher ("Mac", "Homelab") — a different
 * question from `deviceName` (what THIS phone calls itself to that daemon's
 * other clients). Onboarding doesn't ask for it, so callers in that mode can
 * ignore the second argument.
 */
export function Setup({
  onSave,
  onCancel,
  mode = "onboarding",
}: {
  onSave: (config: AppConfig, label: string) => void;
  onCancel?: () => void;
  mode?: "onboarding" | "add-host";
}) {
  const colors = useTheme();
  const styles = makeStyles(colors);
  const [baseUrl, setBaseUrl] = useState("https://");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [deviceName, setDeviceName] = useState("Phone");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<{ repos: number; root: string; url: string; tok: string } | null>(null);
  const adding = mode === "add-host";

  async function connectWith(url: string, tok: string) {
    setError(null);
    setTesting(true);
    try {
      const cleanUrl = url.replace(/\/$/, "");
      const res = await fetch(`${cleanUrl}/repos`, { headers: { authorization: `Bearer ${tok}` } });
      if (res.status === 401) throw new Error("Token rejected (401).");
      if (!res.ok) throw new Error(`Daemon responded ${res.status}.`);
      const body = (await res.json()) as { repos: unknown[]; root: string };
      setFound({ repos: body.repos.length, root: body.root, url: cleanUrl, tok });
    } catch (e) {
      setError(describeConnectionError(e));
    } finally {
      setTesting(false);
    }
  }

  async function continueSetup() {
    if (!found) return;
    onSave({ baseUrl: found.url, token: found.tok, deviceId: await getOrCreateDeviceId(), deviceName }, label.trim());
  }

  function onScanned(raw: string) {
    setScanning(false);
    const pairing = decodePairing(raw);
    if (!pairing) {
      setError("That QR code isn't a Renki pairing code.");
      return;
    }
    setBaseUrl(pairing.baseUrl);
    setToken(pairing.token);
    void connectWith(pairing.baseUrl, pairing.token);
  }

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.body}>
        <Text style={styles.title}>{adding ? "Add another host" : "Connect to your daemon"}</Text>
        <Text style={styles.sub}>
          {adding
            ? "Another daemon this phone can switch to — a homelab box, a laptop. Uses the same take-control identity you already have."
            : "Scan a pairing QR from another Renki device, or enter the details manually."}
        </Text>

        {adding && (
          <>
            <Text style={styles.label}>Name for this host (shown in the switcher)</Text>
            <TextInput style={styles.input} value={label} onChangeText={setLabel} placeholder="e.g. Mac, Homelab" placeholderTextColor={colors.faint} />
          </>
        )}

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
          onChangeText={(v) => {
            setBaseUrl(v);
            setFound(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://homelab.tailnet.ts.net"
          placeholderTextColor={colors.faint}
        />

        <Text style={styles.label}>Auth token</Text>
        <View style={styles.tokenRow}>
          <TextInput
            style={[styles.input, styles.tokenInput]}
            value={token}
            onChangeText={(v) => {
              setToken(v);
              setFound(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!showToken}
            placeholder="RENKI_AUTH_TOKEN"
            placeholderTextColor={colors.faint}
          />
          <TouchableOpacity onPress={() => setShowToken((v) => !v)}>
            <Text style={styles.link}>{showToken ? "Hide" : "Show"}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.label}>This device's name</Text>
        <TextInput style={styles.input} value={deviceName} onChangeText={setDeviceName} />

        {error && <Text style={styles.error}>{error}</Text>}

        {found && (
          <Text style={styles.success}>
            Connected — found {found.repos} repo{found.repos === 1 ? "" : "s"} under {found.root}.
            {found.repos === 0 && " Add a git repo there (or point RENKI_REPOS_ROOT elsewhere) before creating a session."}
          </Text>
        )}

        <TouchableOpacity
          style={[styles.button, (!token || testing) && styles.buttonDisabled]}
          disabled={!token || testing}
          onPress={() => (found ? continueSetup() : connectWith(baseUrl, token))}
        >
          {testing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>{found ? (adding ? "Add host" : "Continue") : "Connect"}</Text>
          )}
        </TouchableOpacity>
        {onCancel && (
          <TouchableOpacity onPress={onCancel} style={{ marginTop: 14, alignItems: "center" }}>
            <Text style={styles.link}>Cancel</Text>
          </TouchableOpacity>
        )}
      </View>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <QrScanner onScanned={onScanned} onCancel={() => setScanning(false)} styles={styles} />
      </Modal>
    </KeyboardAvoidingView>
  );
}

function QrScanner({
  onScanned,
  onCancel,
  styles,
}: {
  onScanned: (raw: string) => void;
  onCancel: () => void;
  styles: Styles;
}) {
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

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  body: { flex: 1, justifyContent: "center", padding: 24, gap: 8 },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  sub: { color: colors.dim, fontSize: 13, marginBottom: 12, textAlign: "center" },
  label: { color: colors.dim, fontSize: 12, marginTop: 8 },
  tokenRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  tokenInput: { flex: 1 },
  input: {
    backgroundColor: colors.panel,
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: colors.text,
    fontSize: 15,
  },
  error: { color: colors.danger, fontSize: 13, marginTop: 8 },
  success: { color: colors.ok, fontSize: 13, marginTop: 8 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 16,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: colors.accentFg, fontWeight: "700", fontSize: 15 },
  scanButton: {
    backgroundColor: colors.panel,
    borderRadius: radius.pill,
    paddingVertical: 13,
    alignItems: "center",
  },
  scanButtonText: { color: colors.accent, fontWeight: "700", fontSize: 15 },
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
    borderRadius: radius.pill,
  },
  cancelOverlayText: { color: "#fff", fontWeight: "600", fontSize: 14 },
});
