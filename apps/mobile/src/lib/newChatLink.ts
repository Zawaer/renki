import type { RepoChoice } from "@renki/client-core";

/**
 * The phone's side of the web's /new links (apps/web/src/lib/newChatLink.ts,
 * kept in step with it): open a new chat with a prompt filled in but NOT sent,
 * and a project picked. Accepted:
 *
 *     renki://new?project=life#prompt=The%20backup%20check%20is%20red
 *     renki://new?project=life&prompt=...          (prompt in the query works too)
 *     https://<any host>/new?project=life#prompt=... (if the OS hands one to the app)
 *
 * Nothing runs until the user reads the prompt and presses send; never send
 * it automatically.
 */
export type NewChatLink = { project: string | null; prompt: string | null };

/** Same parse as the web's, from the URL's parts. */
export function parseNewChatLink(pathname: string, search: string, hash: string): NewChatLink | null {
  if (pathname.replace(/\/+$/, "") !== "/new") return null;
  const query = parseParams(search.replace(/^\?/, ""));
  const fragment = parseParams(hash.replace(/^#/, ""));
  const project = query.get("project")?.trim() || null;
  const prompt = fragment.get("prompt") ?? query.get("prompt") ?? null;
  return { project, prompt: prompt && prompt.trim() ? prompt : null };
}

/**
 * `a=1&b=2` into a map, first value wins. By hand because React Native's
 * URLSearchParams can't parse a string (its get() throws "not implemented").
 */
function parseParams(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decode(eq >= 0 ? part.slice(0, eq) : part);
    if (!out.has(key)) out.set(key, decode(eq >= 0 ? part.slice(eq + 1) : ""));
  }
  return out;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/**
 * A whole URL as the OS delivers it. Split by hand rather than with `URL`:
 * React Native's URL leaves search/hash unimplemented, and a custom scheme's
 * "host" (renki://new) is really the path here.
 */
export function parseIncomingNewChatLink(url: string): NewChatLink | null {
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = beforeHash.indexOf("?");
  const search = queryAt >= 0 ? beforeHash.slice(queryAt) : "";
  const base = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const custom = /^renki:\/\/\/?(.*)$/i.exec(base);
  const web = /^https?:\/\/[^/]+(\/.*)?$/i.exec(base);
  const pathname = custom ? `/${custom[1] ?? ""}` : web ? (web[1] ?? "/") : null;
  return pathname === null ? null : parseNewChatLink(pathname, search, hash);
}

/** Whether a repo is the one a link names: its folder, id, owner/name or just name on GitHub. Same rule as the web. */
export function matchesProject(choice: RepoChoice, project: string): boolean {
  const want = project.trim().toLowerCase();
  const names = [choice.local?.id, choice.local?.name, choice.fullName, choice.fullName?.split("/").pop(), choice.local?.remote ?? undefined];
  return names.some((n) => n?.toLowerCase() === want);
}
