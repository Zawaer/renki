import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
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

  async function connect() {
    setError(null);
    setTesting(true);
    try {
      const url = baseUrl.replace(/\/$/, "");
      const res = await fetch(`${url}/repos`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 401) throw new Error("Token rejected (401).");
      if (!res.ok) throw new Error(`Daemon responded ${res.status}.`);
      onSave({ baseUrl: url, token, deviceId: await getOrCreateDeviceId(), deviceName });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the daemon.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.body}>
        <Text style={styles.title}>Connect to your daemon</Text>
        <Text style={styles.sub}>Enter your homelab daemon URL (via Tailscale) and token.</Text>

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
          onPress={connect}
        >
          {testing ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Connect</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, justifyContent: "center", padding: 24, gap: 8 },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  sub: { color: colors.dim, fontSize: 13, marginBottom: 12 },
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
});
