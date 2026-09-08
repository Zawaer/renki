import type { Account, AccountsResponse } from "@crc/protocol";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useClient } from "../lib/client";
import { radius, type ThemeColors, useTheme } from "../theme";
import { Sheet } from "../components/Sheet";
import { UsageLimits, worstUsagePct } from "../components/UsageLimits";
import { ConnectUsage } from "./ConnectUsage";

/** Compact multi-account usage strip (mirror of the web AccountsBar). */
export function AccountsBar() {
  const colors = useTheme();
  const styles = makeStyles(colors);
  const { rest } = useClient();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);
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

  // The worst figure across every account and window — the one number worth a
  // permanent line on screen, since it's what actually stops the next prompt.
  const worst = data.accounts
    .map((a) => worstUsagePct(a.usage))
    .filter((w): w is NonNullable<typeof w> => w != null)
    .reduce<{ pct: number; severity: "normal" | "warning" | "critical" } | null>(
      (a, b) => (a && a.pct >= b.pct ? a : b),
      null,
    );
  const worstColor =
    worst == null
      ? colors.faint
      : worst.severity === "critical"
        ? colors.error
        : worst.severity === "warning"
          ? colors.busy
          : colors.ok;

  return (
    <>
      {/*
        * One tappable line, not a panel. Expanded inline, the usage cards grew
        * tall enough to cover the session list they sit under — with no way to
        * dismiss them, since this bar has no chrome of its own. The detail now
        * lives in a sheet, which closes by drag, backdrop, X or Android back,
        * mirroring how the web puts the same thing behind an icon.
        */}
      <TouchableOpacity style={styles.bar} onPress={() => setOpen(true)} activeOpacity={0.7}>
        <View style={[styles.dot, { backgroundColor: worstColor }]} />
        <Text style={styles.header}>Accounts</Text>
        {worst != null && <Text style={[styles.barPct, { color: worstColor }]}>{Math.round(worst.pct)}%</Text>}
        <Text style={styles.switch} numberOfLines={1}>
          {switching ? "switching…" : data.rotation.enabled ? `Auto-switch at ${data.rotation.threshold}%` : "Auto-switch off"}
        </Text>
        <Ionicons name="chevron-up" size={14} color={colors.faint} />
      </TouchableOpacity>

      <Sheet visible={open} onClose={() => setOpen(false)} title="Accounts" colors={colors}>
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetBody}>
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
        </ScrollView>
      </Sheet>

      <ConnectUsage visible={connecting} onClose={() => setConnecting(false)} onConnected={refresh} />
    </>
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
  /** One line, fixed height — it sits under the session list and must never grow into it. */
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.bgElevated,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
  },
  barPct: { fontSize: 13, fontWeight: "700", fontVariant: ["tabular-nums"] },
  sheetScroll: { maxHeight: 520 },
  sheetBody: { paddingHorizontal: 14, paddingBottom: 10, gap: 4 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  header: { color: colors.text, fontSize: 14, fontWeight: "700" },
  switch: { color: colors.dim, fontSize: 11, marginLeft: "auto" },
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
