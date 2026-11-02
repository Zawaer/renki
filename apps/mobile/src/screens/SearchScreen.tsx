import { formatHitTime, groupSearchHits, searchHitAnchor, splitSnippet, type SearchGroup } from "@renki/client-core";
import type { SearchHit, SearchResponse } from "@renki/protocol";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { animateLayout, FadeIn } from "../components/Motion";
import { useClient } from "../lib/client";
import { radius, type ThemeColors, useTheme, withAlpha } from "../theme";

/** How many hits a chat shows before its "more" row. */
const PER_CHAT = 3;
const DEBOUNCE_MS = 250;

/**
 * Search everything said in every chat, your prompts and Claude's replies,
 * through the daemon's /search. Mirrors the web's SearchPalette: a hit opens
 * its chat scrolled to that message, with the match marked.
 */
export function SearchScreen({
  onBack,
  onOpenHit,
}: {
  onBack: () => void;
  onOpenHit: (sessionId: string, anchor: string, query: string) => void;
}) {
  const colors = useTheme();
  const styles = makeStyles(colors);
  const insets = useSafeAreaInsets();
  const { rest } = useClient();
  const [query, setQuery] = useState(lastQuery);
  const [result, setResult] = useState<SearchResponse | null>(lastResult);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    lastQuery = query;
    const q = query.trim();
    if (!q) {
      setResult(null);
      setLoading(false);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      rest
        .search(q)
        .then((r) => {
          if (cancelled) return;
          lastResult = r;
          setResult(r);
          setFailed(false);
          setExpanded(new Set());
        })
        .catch(() => !cancelled && setFailed(true))
        .finally(() => !cancelled && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, rest]);

  const groups = useMemo(() => (result ? groupSearchHits(result.hits) : []), [result]);
  const q = query.trim();

  return (
    <View style={styles.fill}>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <TouchableOpacity onPress={onBack} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.field}>
          {loading ? (
            <ActivityIndicator size="small" color={colors.faint} />
          ) : (
            <Ionicons name="search" size={16} color={colors.faint} />
          )}
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder="Search all chats"
            placeholderTextColor={colors.faint}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery("")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={16} color={colors.faint} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView style={styles.fill} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {!q && <Text style={styles.hint}>Search what you and Claude said in every chat. Any word, path or bit of code.</Text>}
        {q && failed && <Text style={styles.hint}>Couldn't search. Is the daemon reachable?</Text>}
        {q && !failed && result && result.query === q && groups.length === 0 && <Text style={styles.hint}>Nothing found for "{q}".</Text>}
        {q && !failed && groups.length > 0 && (
          <FadeIn key={result?.query} distance={0}>
            {groups.map((g) => {
              const shown = expanded.has(g.sessionId) ? g.hits : g.hits.slice(0, PER_CHAT);
              return (
                <View key={g.sessionId} style={styles.group}>
                  <GroupHeader group={g} styles={styles} />
                  {shown.map((hit) => (
                    <HitRow key={`${hit.sessionId}:${hit.seq}`} hit={hit} colors={colors} styles={styles} onOpen={() => onOpenHit(hit.sessionId, searchHitAnchor(hit), result?.query ?? q)} />
                  ))}
                  {shown.length < g.hits.length && (
                    <TouchableOpacity
                      style={styles.more}
                      onPress={() => {
                        animateLayout();
                        setExpanded((prev) => new Set(prev).add(g.sessionId));
                      }}
                    >
                      <Text style={styles.moreText}>{g.hits.length - shown.length} more in this chat</Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
            {result?.truncated && (
              <Text style={styles.note}>Showing the newest {result.hits.length} matches. Add more words to narrow it down.</Text>
            )}
          </FadeIn>
        )}
      </ScrollView>
    </View>
  );
}

/** Kept across visits, so coming back from a hit shows the same results at once while they refresh. */
let lastQuery = "";
let lastResult: SearchResponse | null = null;

function GroupHeader({ group, styles }: { group: SearchGroup; styles: Styles }) {
  return (
    <View style={styles.groupHeader}>
      <Text style={styles.groupTitle} numberOfLines={1}>
        {group.title}
      </Text>
      {group.repoName && (
        <Text style={styles.groupRepo} numberOfLines={1}>
          {group.repoName}
        </Text>
      )}
    </View>
  );
}

function HitRow({ hit, colors, styles, onOpen }: { hit: SearchHit; colors: ThemeColors; styles: Styles; onOpen: () => void }) {
  const [before, match, after] = splitSnippet(hit);
  return (
    <TouchableOpacity style={styles.hit} activeOpacity={0.7} onPress={onOpen}>
      <View style={styles.role} accessibilityLabel={hit.role === "you" ? "You" : "Claude"}>
        <Ionicons name={hit.role === "you" ? "person-outline" : "sparkles-outline"} size={12} color={colors.faint} />
      </View>
      <Text style={styles.snippet} numberOfLines={3}>
        {before}
        <Text style={styles.match}>{match}</Text>
        {after}
      </Text>
      <Text style={styles.time}>{formatHitTime(hit.ts)}</Text>
    </TouchableOpacity>
  );
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 18,
      paddingBottom: 12,
    },
    field: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: colors.inset,
      borderRadius: radius.pill,
      paddingHorizontal: 14,
    },
    input: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 10 },
    body: { paddingHorizontal: 12, paddingBottom: 24 },
    hint: { color: colors.faint, fontSize: 14, textAlign: "center", paddingHorizontal: 24, paddingVertical: 28, lineHeight: 20 },
    note: { color: colors.faint, fontSize: 12, paddingHorizontal: 12, paddingTop: 6 },
    group: { paddingBottom: 6 },
    groupHeader: { flexDirection: "row", alignItems: "baseline", gap: 8, paddingHorizontal: 8, paddingTop: 12, paddingBottom: 4 },
    groupTitle: { color: colors.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
    groupRepo: { color: colors.faint, fontSize: 12, flexShrink: 0, maxWidth: "45%" },
    hit: { flexDirection: "row", alignItems: "flex-start", gap: 10, borderRadius: radius.md, paddingHorizontal: 8, paddingVertical: 8 },
    role: {
      width: 22,
      height: 22,
      borderRadius: radius.sm,
      backgroundColor: colors.inset,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 1,
    },
    snippet: { flex: 1, color: colors.dim, fontSize: 13, lineHeight: 19 },
    match: { color: colors.text, fontWeight: "600", backgroundColor: withAlpha(colors.accent, 0.25) },
    time: { color: colors.faint, fontSize: 11, marginTop: 2 },
    more: { alignSelf: "flex-start", marginLeft: 40, paddingHorizontal: 6, paddingVertical: 4 },
    moreText: { color: colors.faint, fontSize: 12, fontWeight: "600" },
  });
