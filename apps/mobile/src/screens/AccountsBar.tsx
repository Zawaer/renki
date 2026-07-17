import type { Account, AccountsResponse } from "@crc/protocol";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useClient } from "../lib/client";
import { colors } from "../theme";

/** Compact multi-account usage strip (mirror of the web AccountsBar). */
export function AccountsBar() {
  const { rest } = useClient();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [switching, setSwitching] = useState(false);

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
        <AccountRow key={a.number} account={a} />
      ))}
    </View>
  );
}

function AccountRow({ account }: { account: Account }) {
  return (
    <View style={styles.acct}>
      <View style={styles.acctHead}>
        <View style={[styles.dot, { backgroundColor: account.active ? colors.ok : colors.faint }]} />
        <Text style={styles.email} numberOfLines={1}>
          {account.email}
        </Text>
      </View>
      {account.usage ? (
        <View style={styles.meters}>
          <Meter label="5h" pct={account.usage.fiveHour.pct} />
          <Meter label="7d" pct={account.usage.sevenDay.pct} />
        </View>
      ) : (
        <Text style={styles.na}>usage n/a</Text>
      )}
    </View>
  );
}

function Meter({ label, pct }: { label: string; pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = clamped >= 90 ? colors.error : clamped >= 70 ? colors.busy : colors.ok;
  return (
    <View style={styles.meterRow}>
      <Text style={styles.meterLabel}>{label}</Text>
      <View style={styles.track}>
        <View style={[styles.fillBar, { width: `${clamped}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.meterPct}>{Math.round(clamped)}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: 1, borderTopColor: colors.border, padding: 12 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  header: { color: colors.dim, fontSize: 12, fontWeight: "600" },
  switch: { color: colors.accent, fontSize: 12 },
  acct: { marginBottom: 8 },
  acctHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  email: { color: colors.text, fontSize: 12, flex: 1 },
  na: { color: colors.faint, fontSize: 11, marginLeft: 13 },
  meters: { marginLeft: 13, marginTop: 4, gap: 3 },
  meterRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  meterLabel: { color: colors.faint, fontSize: 10, width: 16 },
  track: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.panel2, overflow: "hidden" },
  fillBar: { height: "100%" },
  meterPct: { color: colors.faint, fontSize: 10, width: 32, textAlign: "right" },
});
