import type { ExportFormat } from "@renki/protocol";
import { StorageAccessFramework, EncodingType } from "expo-file-system";
import { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import { useClient } from "../lib/client";
import { radius, type ThemeColors } from "../theme";
import { Sheet } from "./Sheet";

type Choices = { format: ExportFormat; media: boolean; tools: boolean; thinking: boolean; stats: boolean };
const DEFAULTS: Choices = { format: "markdown", media: true, tools: true, thinking: false, stats: false };

/**
 * Export one chat from the phone: the same file the web makes (the daemon
 * builds it), saved into a folder you pick with Android's own picker —
 * Downloads, Drive, anywhere a document provider offers. Uses the Storage
 * Access Framework from expo-file-system, which the app already ships, so
 * this needed no new native module.
 */
export function ExportSheet({
  sessionId,
  title,
  visible,
  onClose,
  colors,
}: {
  sessionId: string;
  title: string;
  visible: boolean;
  onClose: () => void;
  colors: ThemeColors;
}) {
  const { rest } = useClient();
  const [choices, setChoices] = useState<Choices>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const styles = makeStyles(colors);
  const set = <K extends keyof Choices>(k: K, v: Choices[K]) => setChoices((c) => ({ ...c, [k]: v }));

  async function run() {
    setBusy(true);
    try {
      const file = await rest.exportSession(sessionId, choices);
      const folder = await StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!folder.granted) return; // picker dismissed: nothing to say
      const uri = await StorageAccessFramework.createFileAsync(folder.directoryUri, file.filename, mimeOf(file.filename, file.contentType));
      await StorageAccessFramework.writeAsStringAsync(uri, toBase64(file.data), { encoding: EncodingType.Base64 });
      onClose();
      Alert.alert("Exported", `Saved ${file.filename}.`);
    } catch (err) {
      Alert.alert("Couldn't export", err instanceof Error ? err.message : "Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Export chat" colors={colors}>
      <View style={styles.body}>
        <Text style={styles.subtitle} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.segment}>
          {(["markdown", "pdf"] as const).map((f) => (
            <TouchableOpacity
              key={f}
              style={[styles.segmentItem, choices.format === f && styles.segmentActive]}
              onPress={() => set("format", f)}
              accessibilityRole="radio"
              accessibilityState={{ checked: choices.format === f }}
            >
              <Text style={[styles.segmentText, choices.format === f && styles.segmentTextActive]}>{f === "markdown" ? "Markdown" : "PDF"}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Toggle
          label="Include media"
          hint={choices.format === "markdown" ? "Images and files go in a .zip beside the .md" : "Images appear in the PDF"}
          value={choices.media}
          onChange={(v) => set("media", v)}
          styles={styles}
        />
        <Toggle label="Include tool calls" hint="Commands Claude ran, files it edited, and their output" value={choices.tools} onChange={(v) => set("tools", v)} styles={styles} />
        <Toggle label="Include thinking" hint="Claude's reasoning, where it was shown" value={choices.thinking} onChange={(v) => set("thinking", v)} styles={styles} />
        <Toggle label="Include stats" hint="Each reply's duration, tokens and cost" value={choices.stats} onChange={(v) => set("stats", v)} styles={styles} />
        <TouchableOpacity style={[styles.button, busy && { opacity: 0.6 }]} disabled={busy} onPress={() => void run()}>
          {busy ? <ActivityIndicator color={colors.accentFg} /> : <Text style={styles.buttonText}>Export and save…</Text>}
        </TouchableOpacity>
      </View>
    </Sheet>
  );
}

function Toggle({ label, hint, value, onChange, styles }: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void; styles: Styles }) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.toggleHint}>{hint}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

/** Android names the file from its MIME type; text/markdown isn't one it knows everywhere, so keep the name as given. */
function mimeOf(filename: string, contentType: string): string {
  if (filename.endsWith(".md")) return "text/markdown";
  return contentType.split(";")[0]!.trim();
}

/** ArrayBuffer → base64, in chunks so a large export doesn't blow the call stack. */
function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    body: { paddingHorizontal: 20, paddingBottom: 24, gap: 14 },
    subtitle: { color: colors.dim, fontSize: 13, marginTop: -4 },
    segment: { flexDirection: "row", backgroundColor: colors.inset, borderRadius: radius.sm, padding: 4, gap: 4 },
    segmentItem: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: radius.xs },
    segmentActive: { backgroundColor: colors.panel },
    segmentText: { color: colors.dim, fontSize: 14 },
    segmentTextActive: { color: colors.text, fontWeight: "600" },
    toggleRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    toggleLabel: { color: colors.text, fontSize: 15 },
    toggleHint: { color: colors.faint, fontSize: 12.5, marginTop: 2 },
    button: { backgroundColor: colors.accent, borderRadius: radius.pill, alignItems: "center", paddingVertical: 13, marginTop: 4 },
    buttonText: { color: colors.accentFg, fontSize: 15, fontWeight: "700" },
  });
}
