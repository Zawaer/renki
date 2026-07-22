import type { Account, AccountsResponse, AccountUsageExtra } from "@crc/protocol";
import { formatResetIn, formatUsd } from "@crc/client-core";
import { useCallback, useEffect, useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useClient } from "../lib/client";
import { type ThemeColors, useTheme } from "../theme";
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
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!data || data.accounts.length === 0) return null;

  async function switchNow() {
    setSwitching(true);
    try {
      await rest.switchAccount();
    } finally {
      setSwitching(false);
      refresh();
    }
  }

  return (
    <View style={styles.bar}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>
          Accounts {data.rotation.enabled ? `· auto @ ${data.rotation.threshold}%` : "· auto off"}
        </Text>
        <TouchableOpacity onPress={switchNow} disabled={switching}>
          <Text style={styles.switch}>{switching ? "…" : "Switch"}</Text>
        </TouchableOpacity>
      </View>
      {data.accounts.map((a) => (
        <AccountRow
          key={a.number}
          account={a}
          usageConnected={data.usageConnectedEmails.includes(a.email.toLowerCase())}
          onUsageDisconnected={refresh}
          colors={colors}
          styles={styles}
        />
      ))}
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
  colors,
  styles,
}: {
  account: Account;
  usageConnected: boolean;
  onUsageDisconnected: () => void;
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
        <Text style={styles.email} numberOfLines={1}>
          {account.email}
        </Text>
        {usageConnected && (
          <TouchableOpacity onPress={confirmDisconnect} disabled={removing}>
            <Text style={styles.removeUsage}>{removing ? "…" : "✕"}</Text>
          </TouchableOpacity>
        )}
      </View>
      {account.usage ? (
        <View style={styles.meters}>
          <Meter label="5h" pct={account.usage.fiveHour.pct} resetsAt={account.usage.fiveHour.resetsAt} colors={colors} styles={styles} />
          <Meter label="7d" pct={account.usage.sevenDay.pct} resetsAt={account.usage.sevenDay.resetsAt} colors={colors} styles={styles} />
          {account.usage.extra && <ExtraUsageMeter extra={account.usage.extra} colors={colors} styles={styles} />}
        </View>
      ) : (
        <Text style={styles.na}>usage n/a</Text>
      )}
    </View>
  );
}

function Meter({
  label,
  pct,
  resetsAt,
  colors,
  styles,
}: {
  label: string;
  pct: number;
  resetsAt: string | null;
  colors: ThemeColors;
  styles: Styles;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = clamped >= 90 ? colors.error : clamped >= 70 ? colors.busy : colors.ok;
  const resetIn = formatResetIn(resetsAt, Date.now());
  return (
    <View>
      <View style={styles.meterRow}>
        <Text style={styles.meterLabel}>{label}</Text>
        <View style={styles.track}>
          <View style={[styles.fillBar, { width: `${clamped}%`, backgroundColor: color }]} />
        </View>
        <Text style={styles.meterPct}>{Math.round(clamped)}%</Text>
      </View>
      {resetIn && <Text style={styles.resetIn}>resets in {resetIn}</Text>}
    </View>
  );
}

function ExtraUsageMeter({
  extra,
  colors,
  styles,
}: {
  extra: AccountUsageExtra;
  colors: ThemeColors;
  styles: Styles;
}) {
  const clamped = Math.max(0, Math.min(100, extra.pct));
  const color = clamped >= 90 ? colors.error : clamped >= 70 ? colors.busy : colors.ok;
  return (
    <View style={styles.meterRow}>
      <Text style={styles.meterLabel}>extra</Text>
      <View style={styles.track}>
        <View style={[styles.fillBar, { width: `${clamped}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.extraAmount}>
        {formatUsd(extra.usedDollars)} / {formatUsd(extra.limitDollars)}
      </Text>
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
  bar: { borderTopWidth: 1, borderTopColor: colors.border, padding: 12 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  header: { color: colors.dim, fontSize: 12, fontWeight: "600" },
  switch: { color: colors.accent, fontSize: 12 },
  connectBtn: { marginTop: 8 },
  connect: { color: colors.accent, fontSize: 11 },
  acct: { marginBottom: 8 },
  acctHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  email: { color: colors.text, fontSize: 12, flex: 1 },
  removeUsage: { color: colors.faint, fontSize: 13, paddingHorizontal: 4 },
  na: { color: colors.faint, fontSize: 11, marginLeft: 13 },
  meters: { marginLeft: 13, marginTop: 4, gap: 3 },
  meterRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  meterLabel: { color: colors.faint, fontSize: 10, width: 16 },
  track: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.panel2, overflow: "hidden" },
  fillBar: { height: "100%" },
  meterPct: { color: colors.faint, fontSize: 10, width: 32, textAlign: "right" },
  resetIn: { color: colors.faint, fontSize: 9, marginLeft: 22 },
  extraAmount: { color: colors.faint, fontSize: 10, width: 90, textAlign: "right" },
});
