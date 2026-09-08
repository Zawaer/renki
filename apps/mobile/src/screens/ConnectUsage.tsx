import CookieManager from "@react-native-cookies/cookies";
import type { UsageOrg } from "@renki/protocol";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { useClient } from "../lib/client";
import { radius, type ThemeColors, useTheme } from "../theme";

const CLAUDE_URL = "https://claude.ai";

/**
 * Native guided login for the usage %: open claude.ai in a WebView, let the user
 * sign in, then read the (httpOnly) `sessionKey` cookie from the native cookie
 * store. The key is handed to the daemon, which returns the account's orgs; the
 * user then picks WHICH org's usage to track and we persist that choice. A paste
 * field is kept as a fallback. Nothing here touches the coding tokens.
 */
export function ConnectUsage({
  visible,
  onClose,
  onConnected,
}: {
  visible: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const colors = useTheme();
  const styles = makeStyles(colors);
  const { rest } = useClient();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pasteKey, setPasteKey] = useState("");
  const [orgs, setOrgs] = useState<UsageOrg[] | null>(null);
  const pendingKey = useRef<string | null>(null);
  const working = useRef(false);

  // Step 1: exchange a session key for the list of orgs to pick from.
  const resolve = useCallback(
    async (sessionKey: string) => {
      const key = sessionKey.trim();
      if (working.current || !key) return;
      working.current = true;
      setBusy(true);
      setMsg(null);
      try {
        const res = await rest.connectUsageKey(key);
        if (res.orgs && res.orgs.length > 0) {
          pendingKey.current = key;
          setOrgs(res.orgs);
        } else {
          setMsg({ ok: false, text: res.message ?? "That key didn't work." });
        }
      } catch {
        setMsg({ ok: false, text: "Could not reach the daemon." });
      } finally {
        setBusy(false);
        working.current = false;
      }
    },
    [rest],
  );

  // Step 2: persist the chosen org.
  const pick = useCallback(
    async (orgId: string) => {
      const key = pendingKey.current;
      if (working.current || !key) return;
      working.current = true;
      setBusy(true);
      setMsg(null);
      try {
        const res = await rest.connectUsageKey(key, orgId);
        if (res.ok) {
          setMsg({ ok: true, text: `Connected ${res.email ?? "account"} ✓` });
          onConnected();
          setTimeout(onClose, 800);
        } else {
          setMsg({ ok: false, text: res.message ?? "Couldn't connect that org." });
        }
      } catch {
        setMsg({ ok: false, text: "Could not reach the daemon." });
      } finally {
        setBusy(false);
        working.current = false;
      }
    },
    [onConnected, onClose, rest],
  );

  // After each navigation, check whether the login cookie has appeared yet.
  const checkCookies = useCallback(async () => {
    if (orgs || working.current) return;
    try {
      const cookies = await CookieManager.get(CLAUDE_URL, true);
      const value = cookies?.sessionKey?.value;
      if (value?.startsWith("sk-ant-sid")) await resolve(value);
    } catch {
      /* cookie not readable yet — wait for the next navigation */
    }
  }, [orgs, resolve]);

  async function useDifferentAccount() {
    await CookieManager.clearAll(true).catch(() => {});
    pendingKey.current = null;
    setOrgs(null);
    setMsg({ ok: true, text: "Signed out — log in as another account." });
  }

  const fmt = (o: UsageOrg) =>
    o.usage
      ? `5h ${Math.round(o.usage.fiveHour.pct)}% · 7d ${Math.round(o.usage.sevenDay.pct)}%`
      : "no usage data";

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.fill}>
        <View style={styles.header}>
          <Text style={styles.title}>{orgs ? "Choose an organization" : "Connect usage"}</Text>
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.close}>Close</Text>
          </TouchableOpacity>
        </View>

        {orgs ? (
          <ScrollView contentContainerStyle={styles.orgList}>
            <Text style={styles.orgHint}>Pick which organization's usage to track:</Text>
            {orgs.map((o) => (
              <TouchableOpacity key={o.orgId} style={styles.orgRow} disabled={busy} onPress={() => pick(o.orgId)}>
                <Text style={styles.orgName}>{o.name}</Text>
                <Text style={styles.orgUsage}>{fmt(o)}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={useDifferentAccount} style={styles.footRow}>
              <Text style={styles.link}>Use a different account</Text>
            </TouchableOpacity>
            {busy && <ActivityIndicator color={colors.accent} style={{ marginTop: 12 }} />}
            {msg && <Text style={[styles.msg, { color: msg.ok ? colors.ok : colors.danger }]}>{msg.text}</Text>}
          </ScrollView>
        ) : (
          <>
            <View style={styles.web}>
              <WebView
                source={{ uri: `${CLAUDE_URL}/login` }}
                sharedCookiesEnabled
                thirdPartyCookiesEnabled
                onNavigationStateChange={checkCookies}
                onLoadEnd={checkCookies}
              />
            </View>
            <View style={styles.footer}>
              {busy && <ActivityIndicator color={colors.accent} />}
              {msg && <Text style={[styles.msg, { color: msg.ok ? colors.ok : colors.danger }]}>{msg.text}</Text>}
              <Text style={styles.hint}>Sign in above and we'll list your orgs. Or paste a key:</Text>
              <View style={styles.pasteRow}>
                <TextInput
                  value={pasteKey}
                  onChangeText={setPasteKey}
                  placeholder="sk-ant-sid…"
                  placeholderTextColor={colors.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={styles.input}
                />
                <TouchableOpacity
                  onPress={() => resolve(pasteKey)}
                  disabled={busy || pasteKey.trim().length === 0}
                  style={[styles.btn, (busy || pasteKey.trim().length === 0) && styles.btnDisabled]}
                >
                  <Text style={styles.btnText}>Next</Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 56,
    paddingBottom: 14,
    paddingHorizontal: 18,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  close: { color: colors.accent, fontSize: 15 },
  web: { flex: 1 },
  footer: { padding: 18, gap: 8 },
  footRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 8 },
  link: { color: colors.dim, fontSize: 12 },
  msg: { fontSize: 13 },
  hint: { color: colors.faint, fontSize: 12 },
  pasteRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: {
    flex: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    backgroundColor: colors.inset,
  },
  btn: { backgroundColor: colors.accent, borderRadius: radius.pill, paddingHorizontal: 16, paddingVertical: 11 },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: colors.accentFg, fontSize: 13, fontWeight: "600" },
  orgList: { padding: 18, gap: 10 },
  orgHint: { color: colors.dim, fontSize: 13, marginBottom: 4 },
  orgRow: {
    borderRadius: radius.md,
    padding: 14,
    backgroundColor: colors.panel,
    gap: 4,
  },
  orgName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  orgUsage: { color: colors.dim, fontSize: 12 },
});
