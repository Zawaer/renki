import type { SearchHit } from "@renki/protocol";

/** One chat's search hits, in the order the daemon returned them (newest first). */
export type SearchGroup = {
  sessionId: string;
  title: string;
  repoName: string | null;
  hits: SearchHit[];
};

/**
 * Hits grouped by chat, chats ordered by their newest hit — the daemon sends
 * hits newest first, so first appearance is the right order. A repo-less
 * chat gets no repo label rather than the placeholder name it's stored under.
 */
export function groupSearchHits(hits: SearchHit[]): SearchGroup[] {
  const groups = new Map<string, SearchGroup>();
  for (const hit of hits) {
    let group = groups.get(hit.sessionId);
    if (!group) {
      group = {
        sessionId: hit.sessionId,
        title: hit.sessionTitle?.trim() || "Untitled chat",
        repoName: hit.repoId ? hit.repoName : null,
        hits: [],
      };
      groups.set(hit.sessionId, group);
    }
    group.hits.push(hit);
  }
  return [...groups.values()];
}

/**
 * Where in a transcript a hit sits, as the value a chat view looks for:
 * `p:<promptId>` for a prompt, `b:<turnId>:<blockIndex>` for a reply block.
 */
export function searchHitAnchor(hit: SearchHit): string {
  return hit.promptId != null ? `p:${hit.promptId}` : `b:${hit.turnId}:${hit.blockIndex}`;
}

/** Split a hit's snippet around its match, for rendering the match highlighted. */
export function splitSnippet(hit: Pick<SearchHit, "snippet" | "matchStart" | "matchLength">): [string, string, string] {
  const { snippet, matchStart, matchLength } = hit;
  return [snippet.slice(0, matchStart), snippet.slice(matchStart, matchStart + matchLength), snippet.slice(matchStart + matchLength)];
}

/** "14:05" today, "Mon" within the week, "4 Oct" this year, "4 Oct 2025" before that. */
export function formatHitTime(ts: number, now = new Date()): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const ageDays = (now.getTime() - ts) / 86_400_000;
  if (ageDays < 6) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
