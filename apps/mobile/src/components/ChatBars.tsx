import { Ionicons } from "@expo/vector-icons";
import { type BackgroundWork, formatPurgeCountdown, formatTurnDuration } from "@renki/client-core";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useClient } from "../lib/client";
import { radius, type ThemeColors, useTheme, withAlpha } from "../theme";
import { FadeIn, PulseDot } from "./Motion";

/**
 * The slim bars an open chat shows above its composer (and the trash notice
 * under its header), each only while it has something to say: the web's
 * trashed-session notice, background work strip and push/pull banners, laid
 * out as single lines for a phone.
 */

/**
 * In the trash: when it goes, and the way back. The transcript stays readable
 * under it. Restoring brings it back as an archived session, which the
 * header's Unarchive then takes further.
 */
export function TrashedBanner({ sessionId, purgeAt }: { sessionId: string; purgeAt: number | null }) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { rest } = useClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countdown = formatPurgeCountdown(purgeAt);
  return (
    <FadeIn>
      <View style={styles.trash}>
        <Ionicons name="trash-outline" size={16} color={colors.dim} />
        <View style={styles.flex1}>
          <Text style={styles.trashTitle} numberOfLines={1}>
            In the trash{countdown ? ` · ${countdown}` : ""}
          </Text>
          <Text style={[styles.trashSub, error && { color: colors.danger }]} numberOfLines={2}>
            {error ?? "Its worktree and branch are already gone."}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.pillBtn, busy && styles.disabled]}
          disabled={busy}
          accessibilityLabel="Restore, keeps this transcript as an archived session"
          onPress={() => {
            setBusy(true);
            setError(null);
            // No re-watch: this chat is still watched while it's open.
            rest
              .restoreSession(sessionId)
              .catch((err) => setError(err instanceof Error ? err.message : "Couldn't restore this session."))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <ActivityIndicator size="small" color={colors.accentFg} /> : <Text style={styles.pillBtnText}>Restore</Text>}
        </TouchableOpacity>
      </View>
    </FadeIn>
  );
}

/**
 * Agents and commands still running in the background, as one line above the
 * composer: the newest's name, how long it's been going, and how many more.
 * Once the turn that started them ends they're easy to lose mid-reply, and the
 * chat reads idle meanwhile. A tap opens the agents sheet.
 */
export function BackgroundWorkBar({ work, onPress }: { work: BackgroundWork[]; onPress: () => void }) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const newest = work[work.length - 1];
  const elapsed = useElapsedSeconds(newest?.startedAtMs ?? null);
  if (!newest) return null;
  const more = work.length - 1;
  const meta = [
    newest.steps != null ? `${newest.steps} ${newest.steps === 1 ? "step" : "steps"}` : null,
    elapsed != null ? formatTurnDuration(elapsed * 1000) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <FadeIn distance={4}>
      <TouchableOpacity
        style={styles.bar}
        onPress={onPress}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${work.length} running in the background. Show agents`}
      >
        <PulseDot color={colors.ok} size={7} />
        <Text style={styles.barKind}>{newest.kind === "agent" ? "Agent" : "Command"}</Text>
        <Text style={styles.barLabel} numberOfLines={1}>
          {newest.label}
        </Text>
        {more > 0 ? (
          <Text style={styles.barMeta}>+{more} more</Text>
        ) : (
          meta !== "" && <Text style={styles.barMeta}>{meta}</Text>
        )}
        <Ionicons name="chevron-forward" size={13} color={colors.faint} />
      </TouchableOpacity>
    </FadeIn>
  );
}

/**
 * Work to push or pull, as the web's banner: one line with its one action,
 * and an × to put it away (the ⋯ menu still has it). Tapped, it says so until
 * the turn it starts takes it away; new text — other commits — is a fresh
 * offer, and so comes back even after ×.
 */
export function GitBanner({
  icon,
  text,
  action,
  onAction,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  action: string;
  onAction: () => void;
}) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [sentFor, setSentFor] = useState<string | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  if (dismissedFor === text) return null;
  const sent = sentFor === text;
  return (
    <FadeIn distance={4}>
      <View style={styles.bar}>
        <Ionicons name={icon} size={15} color={colors.dim} />
        <Text style={styles.barLabel} numberOfLines={1}>
          {text}
        </Text>
        <TouchableOpacity
          style={[styles.smallBtn, sent && styles.disabled]}
          disabled={sent}
          onPress={() => {
            setSentFor(text);
            onAction();
          }}
          hitSlop={{ top: 8, bottom: 8 }}
        >
          <Text style={styles.smallBtnText}>{sent ? `${action}ing…` : action}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setDismissedFor(text)} hitSlop={10} accessibilityLabel="Hide">
          <Ionicons name="close" size={15} color={colors.faint} />
        </TouchableOpacity>
      </View>
    </FadeIn>
  );
}

function useElapsedSeconds(startedAtMs: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAtMs == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAtMs]);
  return startedAtMs == null ? null : Math.max(0, Math.round((now - startedAtMs) / 1000));
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex1: { flex: 1, minWidth: 0 },
    disabled: { opacity: 0.5 },
    trash: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.inset,
      borderRadius: radius.md,
      marginHorizontal: 14,
      marginBottom: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    trashTitle: { color: colors.text, fontSize: 13, fontWeight: "600" },
    trashSub: { color: colors.dim, fontSize: 12, marginTop: 1 },
    pillBtn: {
      minWidth: 84,
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: radius.pill,
      paddingHorizontal: 14,
      paddingVertical: 7,
    },
    pillBtnText: { color: colors.accentFg, fontSize: 13, fontWeight: "700" },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 14,
      marginBottom: 6,
      paddingHorizontal: 12,
      minHeight: 36,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.panel,
    },
    barKind: { color: colors.dim, fontSize: 12.5 },
    barLabel: { flex: 1, minWidth: 0, color: colors.text, fontSize: 13 },
    barMeta: { color: colors.faint, fontSize: 12, fontVariant: ["tabular-nums"] },
    smallBtn: {
      backgroundColor: withAlpha(colors.accent, 0.14),
      borderRadius: radius.pill,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    smallBtnText: { color: colors.accent, fontSize: 12.5, fontWeight: "700" },
  });
