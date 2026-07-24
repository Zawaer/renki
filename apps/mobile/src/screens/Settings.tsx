import type { Account, AccountsResponse, RotationStatus } from "@crc/protocol";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useClient, useStoreValue } from "../lib/client";
import { radius, type ThemeColors, useTheme, withAlpha } from "../theme";
import { ExtraUsageMeter, Meter } from "./AccountsBar";
import { ConnectUsage } from "./ConnectUsage";
import { PairDevice } from "./PairDevice";

/**
 * Everything about this phone's connection — device name, daemon URL/token,
 * cswap accounts + rotation, pairing, disconnect — in one reachable screen
 * (mirror of the web app's Settings.tsx). Previously the only place any of
 * this showed up was the one-time pre-auth Setup screen, with no way back in
 * short of clearing the app's storage.
 */
export function Settings({
  onBack,
  onReset,
  onReconnect,
  onRenameDevice,
}: {
  onBack: () => void;
  onReset: () => void;
  onReconnect: (baseUrl: string) => Promise<void>;
  onRenameDevice: (name: string) => Promise<void>;
}) {
  const colors = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const { realtime } = useClient();
  const status = useStoreValue(realtime.status);
  const [pairing, setPairing] = useState(false);

  return (
    <View style={styles.fill}>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Settings</Text>
        <View style={{ width: 22 }} />
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <ThisDeviceSection colors={colors} styles={styles} onSaved={onRenameDevice} />
        <ConnectionSection colors={colors} styles={styles} status={status} />
        <AccountsSection styles={styles} />
        <Section
          title="Pair a device"
          description="Show a QR code so another phone or the web app can join without typing the URL and token by hand."
          colors={colors}
          styles={styles}
        >
          <TouchableOpacity style={styles.pairBtn} onPress={() => setPairing(true)}>
            <Ionicons name="qr-code-outline" size={15} color={colors.accent} />
            <Text style={styles.pairBtnText}>Show pairing QR</Text>
          </TouchableOpacity>
        </Section>
        <Section
          title="Disconnect"
          description="Detach this phone from the daemon. Running sessions keep going on the host — you can reconnect anytime."
          danger
          colors={colors}
          styles={styles}
        >
          <TouchableOpacity
            style={styles.dangerBtn}
            onPress={() =>
              Alert.alert("Disconnect", "Detach this phone from the daemon?", [
                { text: "Cancel", style: "cancel" },
                { text: "Disconnect", style: "destructive", onPress: onReset },
              ])
            }
          >
            <Text style={styles.dangerBtnText}>Disconnect</Text>
          </TouchableOpacity>
        </Section>
      </ScrollView>
      <PairDevice visible={pairing} onClose={() => setPairing(false)} onReconnect={onReconnect} />
    </View>
  );
}

function Section({
  title,
  description,
  danger,
  colors,
  styles,
  children,
}: {
  title: string;
  description: string;
  danger?: boolean;
  colors: ThemeColors;
  styles: Styles;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.section, danger && { backgroundColor: withAlpha(colors.danger, 0.08) }]}>
      <Text style={[styles.sectionTitle, danger && { color: colors.danger }]}>{title}</Text>
      <Text style={styles.sectionDesc}>{description}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function ThisDeviceSection({ colors, styles, onSaved }: { colors: ThemeColors; styles: Styles; onSaved: (name: string) => Promise<void> }) {
  const { config } = useClient();
  const [name, setName] = useState(config.deviceName);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim().length > 0 && name.trim() !== config.deviceName;

  async function save() {
    setBusy(true);
    try {
      await onSaved(name.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="This device" description="How this phone identifies itself to the daemon and other clients." colors={colors} styles={styles}>
      <View style={styles.row}>
        <TextInput value={name} onChangeText={setName} style={[styles.input, styles.flex1]} placeholderTextColor={colors.faint} />
        {dirty && (
          <TouchableOpacity style={styles.saveBtn} disabled={busy} onPress={save}>
            <Text style={styles.saveBtnText}>{busy ? "…" : "Save"}</Text>
          </TouchableOpacity>
        )}
      </View>
    </Section>
  );
}

function ConnectionSection({
  colors,
  styles,
  status,
}: {
  colors: ThemeColors;
  styles: Styles;
  status: "connecting" | "open" | "closed";
}) {
  const { config } = useClient();
  const [showToken, setShowToken] = useState(false);
  const badge =
    status === "open"
      ? { color: colors.ok, label: "Connected" }
      : status === "connecting"
        ? { color: colors.busy, label: "Connecting" }
        : { color: colors.danger, label: "Offline" };

  return (
    <Section title="Connection" description="The daemon this phone is attached to." colors={colors} styles={styles}>
      <View style={styles.statusRow}>
        <View style={[styles.dot, { backgroundColor: badge.color }]} />
        <Text style={styles.statusLabel}>{badge.label}</Text>
      </View>
      <View style={styles.dl}>
        <Text style={styles.dt}>Daemon URL</Text>
        <Text style={styles.dd} selectable numberOfLines={1}>
          {config.baseUrl}
        </Text>
      </View>
      <View style={styles.dl}>
        <Text style={styles.dt}>Auth token</Text>
        <View style={styles.tokenRow}>
          <Text style={styles.dd} selectable numberOfLines={1}>
            {showToken ? config.token : "•".repeat(12)}
          </Text>
          <TouchableOpacity onPress={() => setShowToken((v) => !v)}>
            <Text style={styles.link}>{showToken ? "Hide" : "Show"}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Section>
  );
}

function AccountsSection({ styles }: { styles: Styles }) {
  const colors = useTheme();
  const { rest } = useClient();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(() => {
    rest.listAccounts().then(setData).catch(() => {});
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <Section
      title="Accounts"
      description="Coding accounts cswap rotates the claude CLI's credentials across, and the claude.ai key used to read usage %."
      colors={colors}
      styles={styles}
    >
      {!data || data.accounts.length === 0 ? (
        <Text style={styles.muted}>No coding accounts registered with cswap yet — add one below, or see SETUP.md.</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {data.accounts.map((a) => (
            <AccountRow
              key={a.number}
              account={a}
              usageConnected={data.usageConnectedEmails.includes(a.email.toLowerCase())}
              onChanged={refresh}
              colors={colors}
              styles={styles}
            />
          ))}
        </View>
      )}

      {data && data.accounts.length > 1 && <RotationSettings rotation={data.rotation} onChanged={refresh} colors={colors} styles={styles} />}

      <View style={styles.divider}>
        <TouchableOpacity onPress={() => setConnecting(true)}>
          <Text style={styles.link}>{data?.usageConfigured ? "+ Add usage account" : "Connect usage %"}</Text>
        </TouchableOpacity>
      </View>

      <AddCodingAccount onAdded={refresh} colors={colors} styles={styles} />

      <ConnectUsage visible={connecting} onClose={() => setConnecting(false)} onConnected={refresh} />
    </Section>
  );
}

/** Auto-switch accounts once the active one's usage crosses a threshold — the policy `AccountRotator` polls for. */
function RotationSettings({
  rotation,
  onChanged,
  colors,
  styles,
}: {
  rotation: RotationStatus;
  onChanged: () => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  const { rest } = useClient();
  const [threshold, setThreshold] = useState(String(rotation.threshold));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setThreshold(String(rotation.threshold));
  }, [rotation.threshold]);

  async function toggleEnabled(next: boolean) {
    setBusy(true);
    try {
      await rest.updateRotation({ enabled: next });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function saveThreshold() {
    const n = Number(threshold);
    if (!Number.isFinite(n) || n < 1 || n > 100) return;
    setBusy(true);
    try {
      await rest.updateRotation({ threshold: n });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const thresholdDirty = threshold.trim() !== "" && Number(threshold) !== rotation.threshold;

  return (
    <View style={styles.rotation}>
      <View style={styles.row}>
        <Switch value={rotation.enabled} disabled={busy} onValueChange={toggleEnabled} />
        <Text style={[styles.muted, styles.flex1]}>Automatically switch accounts when usage hits the threshold</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.muted}>Switch at</Text>
        <TextInput
          value={threshold}
          onChangeText={setThreshold}
          keyboardType="number-pad"
          style={styles.thresholdInput}
          placeholderTextColor={colors.faint}
        />
        <Text style={styles.muted}>% usage (5h or 7d)</Text>
        {thresholdDirty && (
          <TouchableOpacity style={styles.saveBtn} disabled={busy} onPress={saveThreshold}>
            <Text style={styles.saveBtnText}>Save</Text>
          </TouchableOpacity>
        )}
      </View>
      {rotation.enabled && rotation.lastHoldReason && <Text style={styles.faintNote}>holding: {rotation.lastHoldReason}</Text>}
    </View>
  );
}

function AccountRow({
  account,
  usageConnected,
  onChanged,
  colors,
  styles,
}: {
  account: Account;
  usageConnected: boolean;
  onChanged: () => void;
  colors: ThemeColors;
  styles: Styles;
}) {
  const { rest } = useClient();
  const [busy, setBusy] = useState<null | "switch" | "disconnect">(null);

  async function makeActive() {
    setBusy("switch");
    try {
      const res = await rest.switchAccount(account.number);
      if (!res.ok && res.message) Alert.alert("Couldn't switch", res.message);
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  function confirmDisconnect() {
    Alert.alert("Stop tracking usage?", `Stop tracking usage % for ${account.email}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Stop tracking",
        style: "destructive",
        onPress: async () => {
          setBusy("disconnect");
          try {
            await rest.disconnectUsageKey(account.email);
          } finally {
            setBusy(null);
            onChanged();
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.acctRow}>
      <View style={styles.acctHead}>
        <View style={[styles.dot, { backgroundColor: account.active ? colors.ok : colors.faint }]} />
        <Text style={styles.acctEmail} numberOfLines={1}>
          {account.email}
        </Text>
        {usageConnected && (
          <TouchableOpacity onPress={confirmDisconnect} disabled={busy !== null}>
            <Text style={styles.faintLink}>{busy === "disconnect" ? "…" : "Stop tracking"}</Text>
          </TouchableOpacity>
        )}
        {!account.active && (
          <TouchableOpacity onPress={makeActive} disabled={busy !== null}>
            <Text style={styles.link}>{busy === "switch" ? "…" : "Make active"}</Text>
          </TouchableOpacity>
        )}
      </View>
      {account.usage ? (
        <View style={styles.acctMeters}>
          <Meter label="5h" pct={account.usage.fiveHour.pct} resetsAt={account.usage.fiveHour.resetsAt} colors={colors} />
          <Meter label="7d" pct={account.usage.sevenDay.pct} resetsAt={account.usage.sevenDay.resetsAt} colors={colors} />
          {account.usage.extra && <ExtraUsageMeter extra={account.usage.extra} colors={colors} />}
        </View>
      ) : (
        <Text style={styles.acctNa}>usage n/a</Text>
      )}
    </View>
  );
}

/**
 * Register a brand-new coding account via `cswap add-token` — a value printed
 * by `claude setup-token`, or a plain Anthropic Console API key. Distinct from
 * the usage-tracking key above: this is the credential the official `claude`
 * CLI actually runs inference with.
 */
function AddCodingAccount({ onAdded, colors, styles }: { onAdded: () => void; colors: ThemeColors; styles: Styles }) {
  const { rest } = useClient();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await rest.addSetupTokenAccount(trimmed);
      if (res.ok) {
        setMsg({ ok: true, text: res.email ? `Added ${res.email}.` : "Account added." });
        setToken("");
        onAdded();
      } else {
        setMsg({ ok: false, text: res.message ?? "Couldn't add that account." });
      }
    } catch {
      setMsg({ ok: false, text: "Could not reach the daemon." });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <TouchableOpacity onPress={() => setOpen(true)} style={styles.divider}>
        <Text style={styles.link}>+ Add coding account</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.addAccount}>
      <Text style={styles.muted}>
        Paste the output of `claude setup-token`, or a plain Anthropic Console API key. Runs `cswap add-token` on the daemon host.
      </Text>
      <TextInput
        value={token}
        onChangeText={setToken}
        placeholder="sk-ant-…"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        style={styles.tokenInput}
      />
      <View style={styles.row}>
        <TouchableOpacity onPress={() => setOpen(false)}>
          <Text style={styles.faintLink}>Close</Text>
        </TouchableOpacity>
        <View style={styles.flex1} />
        <TouchableOpacity style={styles.saveBtn} disabled={busy || token.trim().length === 0} onPress={submit}>
          {busy ? <ActivityIndicator size="small" color={colors.accentFg} /> : <Text style={styles.saveBtnText}>Add account</Text>}
        </TouchableOpacity>
      </View>
      {msg && <Text style={{ color: msg.ok ? colors.ok : colors.danger, fontSize: 12 }}>{msg.text}</Text>}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingBottom: 14,
    },
    title: { color: colors.text, fontSize: 18, fontWeight: "700" },
    body: { padding: 16, gap: 14 },
    section: { backgroundColor: colors.panel, borderRadius: radius.lg, padding: 16 },
    sectionTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
    sectionDesc: { color: colors.faint, fontSize: 12, marginTop: 3, lineHeight: 17 },
    sectionBody: { marginTop: 12 },
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    flex1: { flex: 1 },
    input: {
      backgroundColor: colors.panel2,
      borderRadius: radius.sm,
      paddingHorizontal: 12,
      paddingVertical: 9,
      color: colors.text,
      fontSize: 14,
    },
    saveBtn: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
    saveBtnText: { color: colors.accentFg, fontSize: 13, fontWeight: "700" },
    statusRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 },
    dot: { width: 7, height: 7, borderRadius: 4 },
    statusLabel: { color: colors.dim, fontSize: 12 },
    dl: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingTop: 10, marginTop: 2 },
    dt: { color: colors.faint, fontSize: 12 },
    dd: { color: colors.text, fontSize: 12, flexShrink: 1 },
    tokenRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    link: { color: colors.accent, fontSize: 12, fontWeight: "600" },
    faintLink: { color: colors.faint, fontSize: 12 },
    muted: { color: colors.faint, fontSize: 12 },
    faintNote: { color: colors.faint, fontSize: 11, marginTop: 4 },
    acctRow: { backgroundColor: colors.panel2, borderRadius: radius.md, padding: 12 },
    acctHead: { flexDirection: "row", alignItems: "center", gap: 8 },
    acctEmail: { color: colors.text, fontSize: 13, fontWeight: "600", flex: 1 },
    acctMeters: { marginTop: 8, marginLeft: 15, gap: 4 },
    acctNa: { color: colors.faint, fontSize: 11, marginLeft: 15, marginTop: 4 },
    rotation: { marginTop: 14, gap: 10 },
    thresholdInput: {
      backgroundColor: colors.panel2,
      borderRadius: radius.sm,
      paddingHorizontal: 10,
      paddingVertical: 5,
      color: colors.text,
      fontSize: 13,
      width: 56,
      textAlign: "center",
    },
    divider: { marginTop: 14 },
    addAccount: { marginTop: 10, borderRadius: radius.md, backgroundColor: colors.panel2, padding: 12, gap: 8 },
    tokenInput: {
      backgroundColor: colors.bg,
      borderRadius: radius.sm,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.text,
      fontSize: 12,
      minHeight: 60,
      textAlignVertical: "top",
    },
    pairBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      backgroundColor: withAlpha(colors.accent, 0.14),
      borderRadius: radius.pill,
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    pairBtnText: { color: colors.accent, fontSize: 13, fontWeight: "700" },
    dangerBtn: { backgroundColor: colors.danger, borderRadius: radius.pill, paddingVertical: 10, paddingHorizontal: 18, alignSelf: "flex-start" },
    dangerBtnText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  });
