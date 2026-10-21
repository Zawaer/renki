import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import type { Attachment } from "@renki/protocol";
import { unzipSync } from "fflate";

/** Unpacked size cap per archive — a 15MB zip of text can inflate a long way, and this all lands on the daemon's disk. */
export const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
export const MAX_UNPACKED_FILES = 5000;
/** How many of an archive's files the note names before it just gives a count. */
const LISTED_FILES = 200;

/**
 * The model can't take a zip as a content block, so a zip attachment is
 * unpacked to disk instead and Claude is told where: it reads what it needs
 * with its own tools, like a file referenced by path. Unpacks under
 * `<dir>/<promptId>/<zip name>`, so a retried prompt lands in the same place.
 * Returns the remaining (non-zip) attachments and a note to put before the
 * prompt text; the note says so when an archive couldn't be unpacked.
 */
export function unpackArchives(
  attachments: Attachment[] | undefined,
  dir: string,
  promptId: string,
): { attachments?: Attachment[]; note: string } {
  const zips = attachments?.filter((a) => a.mediaType === "application/zip") ?? [];
  if (zips.length === 0) return { attachments, note: "" };
  const rest = attachments!.filter((a) => a.mediaType !== "application/zip");
  const notes = zips.map((a, i) => {
    const target = join(dir, safeSegment(promptId), `${i + 1}-${safeSegment(a.name.replace(/\.zip$/i, ""))}`);
    try {
      return describe(a.name, target, unpack(Buffer.from(a.data, "base64"), target));
    } catch (err) {
      rmSync(target, { recursive: true, force: true });
      return `[The user attached ${a.name}, but it couldn't be unpacked: ${err instanceof Error ? err.message : String(err)}]`;
    }
  });
  return { attachments: rest.length ? rest : undefined, note: notes.join("\n") + "\n\n" };
}

/** Writes the archive's files under `target` and returns their paths relative to it, with sizes. */
function unpack(zip: Uint8Array, target: string): Array<{ path: string; size: number }> {
  let declared = 0;
  let count = 0;
  const files = unzipSync(zip, {
    // Checked against the sizes the archive declares, before anything is inflated…
    filter: (f) => {
      if (!keep(f.name)) return false;
      declared += f.originalSize;
      count += 1;
      if (count > MAX_UNPACKED_FILES) throw new Error(`more than ${MAX_UNPACKED_FILES} files`);
      if (declared > MAX_UNPACKED_BYTES) throw new Error(`more than ${MAX_UNPACKED_BYTES / (1024 * 1024)}MB unpacked`);
      return true;
    },
  });
  // …and against what actually came out, which a crafted archive can misstate.
  const total = Object.values(files).reduce((n, data) => n + data.length, 0);
  if (total > MAX_UNPACKED_BYTES) throw new Error(`more than ${MAX_UNPACKED_BYTES / (1024 * 1024)}MB unpacked`);

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const root = resolve(target) + sep;
  const out: Array<{ path: string; size: number }> = [];
  for (const [name, data] of Object.entries(files)) {
    const rel = posix.normalize(name.replace(/\\/g, "/"));
    const dest = resolve(target, rel);
    // Zip-slip: an entry like "../../.bashrc" or "/etc/x" must not leave the folder.
    if (!dest.startsWith(root)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    out.push({ path: rel, size: data.length });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Files only (fflate also lists directories, as names ending in "/"), minus the junk macOS's Compress adds. */
function keep(name: string): boolean {
  if (name.endsWith("/")) return false;
  const parts = name.split(/[\\/]/);
  return !parts.includes("__MACOSX") && parts[parts.length - 1] !== ".DS_Store";
}

function describe(name: string, target: string, files: Array<{ path: string; size: number }>): string {
  if (files.length === 0) return `[The user attached ${name}; it holds no files.]`;
  const listed = files.slice(0, LISTED_FILES).map((f) => `- ${f.path} (${formatSize(f.size)})`);
  if (files.length > LISTED_FILES) listed.push(`- …and ${files.length - LISTED_FILES} more`);
  return `[The user attached ${name}, unpacked to ${target} — ${files.length} file${files.length === 1 ? "" : "s"}:\n${listed.join("\n")}]`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A name safe as one path segment. */
function safeSegment(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "archive";
}
