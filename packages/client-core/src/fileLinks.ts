/**
 * Telling a link in Claude's reply that points at a file in the session's
 * working tree — `[notes.md](notes.md)`, `[foo.ts:42](src/foo.ts#L42)`, an
 * absolute path inside the worktree — apart from a web link, so a client can
 * open the file beside the conversation instead of handing it to the browser.
 *
 * DOM-free and pure so every client shares the rules and they stay testable.
 */

export type FileLink = {
  /** Relative to the worktree root, `/`-separated, never escaping it. */
  path: string;
  /** 1-based line to show, from `#L42`, `#L42-L50` or a trailing `:42`. */
  line?: number;
};

/** Schemes that are never files, even without `//` (`mailto:you@x`). */
const NON_FILE_SCHEMES = /^(mailto|tel|sms|data|javascript|vbscript|about|blob|news|xmpp|magnet|geo|urn):/i;
/** `scheme://…` — a URL of some kind. */
const URL_WITH_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Classify a Markdown link target. Returns the worktree-relative path (and
 * line, if one was given) when `href` names a file inside the worktree, or
 * null for anything else: web and mail links, in-page anchors, other
 * schemes, absolute paths outside the worktree, and relative paths that `..`
 * their way out of it.
 *
 * `worktreePath` is the session's absolute worktree root; without it only
 * relative links can match. `fromDir` is the worktree-relative directory the
 * link was written in (a Markdown file being viewed links relative to
 * itself); a reply's links are relative to the root.
 */
export function parseFileLink(href: string | null | undefined, worktreePath: string | null | undefined, fromDir = ""): FileLink | null {
  let raw = (href ?? "").trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("?")) return null;
  if (/^file:\/\//i.test(raw)) {
    raw = raw.replace(/^file:\/\/(localhost)?/i, "");
    if (!raw.startsWith("/")) return null;
  } else if (URL_WITH_AUTHORITY.test(raw) || NON_FILE_SCHEMES.test(raw) || raw.startsWith("//")) {
    return null;
  }

  // Fragment: `#L42`, `#L42-L50`, `#L42C3` give a line; any other fragment
  // (a heading in a Markdown file) is dropped.
  let line: number | undefined;
  const hash = raw.indexOf("#");
  if (hash !== -1) {
    const m = /^L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i.exec(raw.slice(hash + 1));
    if (m) line = Number(m[1]);
    raw = raw.slice(0, hash);
  }
  const query = raw.indexOf("?");
  if (query !== -1) raw = raw.slice(0, query);

  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    path = raw;
  }

  // Trailing `:42`, `:42:7` or `:42-50`, the way compilers and Claude cite a line.
  const suffix = /:(\d+)(?::\d+|-\d+)?$/.exec(path);
  if (suffix) {
    if (line === undefined) line = Number(suffix[1]);
    path = path.slice(0, suffix.index);
  }
  if (line !== undefined && !(line >= 1)) line = undefined;

  // Anything else that still looks like `scheme:rest` is a link we don't know.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  if (!path || path.startsWith("~") || path.includes("\0")) return null;

  let segments: string[];
  if (path.startsWith("/")) {
    if (!worktreePath) return null;
    const root = worktreePath.replace(/\/+$/, "");
    if (!root || (path !== root && !path.startsWith(root + "/"))) return null;
    segments = path.slice(root.length).split("/");
  } else {
    segments = [...fromDir.split("/"), ...path.split("/")];
  }

  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null; // climbs out of the worktree
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) return null;
  return line === undefined ? { path: out.join("/") } : { path: out.join("/"), line };
}
