import {
  type GatewayApproval,
  type GatewayPeek,
  answerGatewayApproval,
  describeGatewayOutcome,
  formatTimeLeft,
  peekGatewayApproval,
} from "@renki/client-core";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, ToastAndroid, TouchableOpacity, View } from "react-native";
import { radius, type ThemeColors } from "../theme";
import { Sheet } from "./Sheet";
import { confirmIdentity } from "../lib/confirmIdentity";

/** One request the homelab gateway is waiting on, and where it came from. */
export type PendingApproval = {
  approval: GatewayApproval;
  /** The notification it arrived as, so it can be cleared from the tray once settled. */
  notificationId?: string;
  /** Found by looking at the tray rather than tapped: say nothing if it turns out to be settled already. */
  quiet?: boolean;
};

/**
 * The popup for a gateway approval (docs/homelab-gateway.md), shown when the app is open, when it
 * comes to the front with one waiting, or when its notification is tapped. It asks the approval
 * service itself what the request says and whether it is still open, so what you approve is the
 * gateway's wording, and a stale or already-answered request never asks for a decision.
 */
export function GatewayApprovalSheet({
  pending,
  onClose,
  colors,
}: {
  pending: PendingApproval | null;
  onClose: (settled: boolean) => void;
  colors: ThemeColors;
}) {
  const styles = makeStyles(colors);
  // Keep showing the last request while the sheet slides away.
  const last = useRef<PendingApproval | null>(null);
  if (pending) last.current = pending;
  const shown = pending ?? last.current;

  const [peek, setPeek] = useState<GatewayPeek | undefined>(undefined); // undefined = not reached yet
  /** How many tries in a row couldn't reach the homelab (it keeps trying while the popup is open). */
  const [misses, setMisses] = useState(0);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [now, setNow] = useState(Date.now());
  /** The sudo password for a root command. Kept only in this popup; cleared whenever it changes request or closes. */
  const [password, setPassword] = useState("");
  const id = pending?.approval.id;

  useEffect(() => {
    // Closing leaves the last content up while the sheet slides away; only a new request resets it.
    if (!pending) return;
    setPeek(undefined);
    setMisses(0);
    setBusy(null);
    setPassword("");
    let live = true;
    // Keep asking until the homelab answers: right after the phone wakes, the tailnet can take a
    // while to come back, and one failed (or hung) try used to leave the popup spinning for good.
    const ask = async (miss: number) => {
      const p = await peekGatewayApproval(pending.approval);
      if (!live) return;
      if (p) {
        setPeek(p);
        // Found in the tray and already settled: nothing to ask, so just tidy up.
        if (pending.quiet && p.state !== "pending") onClose(true);
        return;
      }
      setMisses(miss + 1);
      setTimeout(() => void (live && ask(miss + 1)), 3_000);
    };
    void ask(0);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function answer(decision: "approve" | "deny") {
    if (!pending) return;
    if (decision === "approve" && !(await confirmIdentity("Approve on the homelab"))) return;
    setBusy(decision);
    const needsPassword = decision === "approve" && peek?.password;
    const outcome = await answerGatewayApproval(pending.approval, decision, undefined, needsPassword ? password : undefined);
    setBusy(null);
    if (outcome !== "failed") setPassword("");
    toast(describeGatewayOutcome(outcome, decision));
    if (outcome !== "failed") onClose(true);
  }

  const open = Boolean(pending) && !(pending?.quiet && peek && peek.state !== "pending");
  const secondsLeft = peek ? Math.ceil(peek.expires - now / 1000) : null;
  const expired = peek ? peek.state === "expired" || (peek.state === "pending" && secondsLeft! <= 0) : false;
  const settled = peek ? peek.state === "approve" || peek.state === "deny" : false;

  return (
    <Sheet visible={open} onClose={() => onClose(false)} title="Approve on the homelab?" colors={colors}>
      <View style={styles.body}>
        {shown && peek === undefined && misses === 0 && <ActivityIndicator color={colors.accent} />}

        {shown && peek === undefined && misses > 0 && (
          <>
            <View style={styles.row}>
              <ActivityIndicator color={colors.accent} />
              <Text style={[styles.text, { flex: 1 }]}>Can't reach the homelab yet. Trying again (attempt {misses + 1}).</Text>
            </View>
            <Text style={styles.dim}>Check that Tailscale is connected on this phone. The request stays open for up to five minutes.</Text>
            <TouchableOpacity style={styles.secondary} onPress={() => onClose(false)}>
              <Text style={styles.secondaryText}>Close</Text>
            </TouchableOpacity>
          </>
        )}

        {shown && peek && (expired || settled) && (
          <>
            <Text style={styles.summary}>{peek.summary}</Text>
            <Text style={styles.dim}>
              {settled ? (peek.state === "approve" ? "Already approved." : "Already denied.") : "This request ran out of time and was denied."}
            </Text>
            <TouchableOpacity style={styles.secondary} onPress={() => onClose(true)}>
              <Text style={styles.secondaryText}>Close</Text>
            </TouchableOpacity>
          </>
        )}

        {shown && peek && !expired && !settled && (
          <>
            <Text style={[styles.summary, peek.password && styles.root]}>{peek.summary}</Text>
            {peek.password && (
              <TextInput
                style={styles.password}
                value={password}
                onChangeText={setPassword}
                placeholder="Your sudo password"
                placeholderTextColor={colors.faint}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
                textContentType="none"
                returnKeyType="done"
              />
            )}
            <Text style={styles.dim}>
              A Renki session asked for this. Waiting for you: {formatTimeLeft(peek.expires, now)} left, then it is denied.
            </Text>
            <View style={styles.row}>
              <TouchableOpacity style={[styles.deny, busy && styles.busy]} disabled={busy !== null} onPress={() => void answer("deny")}>
                {busy === "deny" ? <ActivityIndicator color={colors.text} /> : <Text style={styles.denyText}>Deny</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.approve, (busy || (peek.password && !password)) && styles.busy]}
                disabled={busy !== null || (peek.password && !password)}
                onPress={() => void answer("approve")}
              >
                {busy === "approve" ? <ActivityIndicator color={colors.accentFg} /> : <Text style={styles.approveText}>Approve</Text>}
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => onClose(false)} hitSlop={10}>
              <Text style={styles.later}>Not now</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </Sheet>
  );
}

function toast(message: string): void {
  if (Platform.OS === "android") ToastAndroid.show(message, ToastAndroid.LONG);
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    // The shared Sheet already pads the bottom (to clear the gesture bar), so none more here.
    body: { paddingHorizontal: 20, paddingBottom: 2, gap: 14 },
    summary: { color: colors.text, fontSize: 17, lineHeight: 24, fontWeight: "600" },
    text: { color: colors.text, fontSize: 15 },
    dim: { color: colors.dim, fontSize: 13.5, lineHeight: 19 },
    row: { flexDirection: "row", gap: 12, marginTop: 4 },
    approve: { flex: 1.3, backgroundColor: colors.accent, borderRadius: radius.pill, alignItems: "center", paddingVertical: 14 },
    approveText: { color: colors.accentFg, fontSize: 16, fontWeight: "700" },
    deny: { flex: 1, backgroundColor: colors.inset, borderRadius: radius.pill, alignItems: "center", paddingVertical: 14 },
    denyText: { color: colors.text, fontSize: 16, fontWeight: "600" },
    secondary: { backgroundColor: colors.inset, borderRadius: radius.pill, alignItems: "center", paddingVertical: 13 },
    secondaryText: { color: colors.text, fontSize: 15, fontWeight: "600" },
    busy: { opacity: 0.6 },
    root: { color: colors.danger },
    password: {
      color: colors.text,
      backgroundColor: colors.inset,
      borderRadius: radius.md,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
    },
    later: { color: colors.faint, fontSize: 14, textAlign: "center", paddingVertical: 4 },
  });
}
