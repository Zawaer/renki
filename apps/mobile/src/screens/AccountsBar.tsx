import type { Account, AccountsResponse } from "@crc/protocol";
import { useCallback, useEffect, useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useClient } from "../lib/client";
import { radius, type ThemeColors, useTheme } from "../theme";
import { UsageLimits } from "../components/UsageLimits";
import { ConnectUsage } from "./ConnectUsage";

/** Compact multi-account usage strip (mirror of the web AccountsBar). */
export function AccountsBar() {
  const colors = useTheme();
  const styles = makeStyles(colors);
  const { rest } = useClient();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [switching, setSwitching] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(() => {
    rest.listAccounts().then(setData).catch(() => {});
  }, [rest]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!data || data.accounts.length === 0) return null;

  function switchTo(account: Account) {
    if (account.active || switching) return;
    Alert.alert("Switch account", `Switch to ${account.email}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Switch",
        onPress: async () => {
          setSwitching(true);
          try {
            const res = await rest.switchAccount(account.number);
            if (!res.ok && res.message) Alert.alert("Couldn't switch", res.message);
          } finally {
            setSwitching(false);
            refresh();
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.bar}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>Accounts</Text>
        <Text style={styles.switch}>
          {switching
            ? "switching…"
            : data.rotation.enabled
              ? `Auto-switch at ${data.rotation.threshold}%`
              : "Auto-switch off"}
        </Text>
      </View>
      {data.accounts.map((a) => (
        <AccountRow
          key={a.number}
          account={a}
          usageConnected={data.usageConnectedEmails.includes(a.email.toLowerCase())}
          onUsageDisconnected={refresh}
          onSwitch={switchTo}
          switching={switching}
          colors={colors}
          styles={styles}
        />
      ))}
      {data.rotation.enabled && data.rotation.lastHoldReason && (
        <Text style={styles.holdReason}>Not switching — {data.rotation.lastHoldReason}</Text>
      )}
      <TouchableOpacity onPress={() => setConnecting(true)} style={styles.connectBtn}>
        <Text style={styles.connect}>{data.usageConfigured ? "+ Add usage account" : "Connect usage %"}</Text>
      </TouchableOpacity>
      <ConnectUsage visible={connecting} onClose={() => setConnecting(false)} onConnected={refresh} />
    </View>
  );
}

function AccountRow({
  account,
  usageConnected,
  onUsageDisconnected,
  onSwitch,
  switching,
  colors,
  styles,
}: {
  account: Account;
  usageConnected: boolean;
  onUsageDisconnected: () => void;
  onSwitch: (account: Account) => void;
  switching: boolean;
  colors: ThemeColors;
  styles: Styles;
}) {
  const { rest } = useClient();
  const [removing, setRemoving] = useState(false);

  function confirmDisconnect() {
    Alert.alert("Stop tracking usage?", `Stop tracking usage % for ${account.email}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Stop tracking",
        style: "destructive",
        onPress: async () => {
          setRemoving(true);
          try {
            await rest.disconnectUsageKey(account.email);
            onUsageDisconnected();
          } finally {
            setRemoving(false);
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.acct}>
      <View style={styles.acctHead}>
        <View style={[styles.dot, { backgroundColor: account.active ? colors.ok : colors.faint }]} />
        <TouchableOpacity
          style={styles.emailBtn}
          onPress={() => onSwitch(account)}
          disabled={account.active || switching}
        >
          <Text style={[styles.email, !account.active && styles.emailSwitchable]} numberOfLines={1}>
            {account.email}
          </Text>
        </TouchableOpacity>
        {usageConnected && (
          <TouchableOpacity onPress={confirmDisconnect} disabled={removing}>
            <Text style={styles.removeUsage}>{removing ? "…" : "✕"}</Text>
          </TouchableOpacity>
        )}
      </View>
      {account.usage ? (
        <View style={styles.meters}>
          <UsageLimits usage={account.usage} colors={colors} />
        </View>
      ) : (
        <Text style={styles.na}>usage n/a</Text>
      )}
    </View>
  );
}


type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
  bar: { backgroundColor: colors.panel, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: 14, paddingBottom: 18 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  header: { color: colors.text, fontSize: 14, fontWeight: "700" },
  switch: { color: colors.dim, fontSize: 11 },
  holdReason: { color: colors.dim, fontSize: 11, marginTop: 2 },
  connectBtn: { marginTop: 10 },
  connect: { color: colors.link, fontSize: 12 },
  acct: { marginBottom: 12 },
  acctHead: { flexDirection: "row", alignItems: "center", gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  emailBtn: { flex: 1 },
  email: { color: colors.text, fontSize: 13, fontWeight: "600" },
  emailSwitchable: { color: colors.accent },
  removeUsage: { color: colors.faint, fontSize: 13, paddingHorizontal: 4 },
  na: { color: colors.faint, fontSize: 11, marginLeft: 14 },
  meters: { marginLeft: 14, marginTop: 6 },
});
