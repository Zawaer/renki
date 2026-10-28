import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { removeCheckout, unsavedWork } from "../git/leftovers.js";

const run = promisify(execFile);

/**
 * What archiving clears out of a chat's folder: the bulk that can be had
 * again, so an archived chat costs its transcript and the files only it has,
 * not gigabytes of installs and builds.
 *
 * Removed:
 * - installed packages and caches (node_modules, .gradle, .next, ...)
 * - build output (build/, dist/, target/) next to the manifest that makes it
 * - downloaded toolchains: an Android SDK, a JDK, ESP-IDF's tools, Python venvs
 * - git checkouts with everything in them on a remote (see git/leftovers.ts)
 *
 * Everything else stays: notes, scripts, data, screenshots, and any checkout
 * with work that isn't on a remote. Inside a checkout, only what git ignores
 * is ever removed. When unsure, it stays.
 */

/** Always something a package manager or build tool recreates. */
const REGENERABLE = new Set([
  "node_modules",
  ".pnpm-store",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".gradle",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
]);
/** Build output, but only next to a manifest that builds it: on its own, a folder called build could be anything. */
const BUILD_OUTPUT = new Set(["build", "dist", "target"]);
const MANIFESTS = [
  "package.json",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "Cargo.toml",
  "pom.xml",
  "CMakeLists.txt",
  "pyproject.toml",
  "setup.py",
];
const ANDROID_SDK_PARTS = ["platform-tools", "cmdline-tools", "build-tools", "platforms", "ndk"];

export type SlimOutcome = {
  /** `what` groups removals in the notice: "node_modules", "build output", "Android SDK", "clone"... */
  removed: { path: string; what: string; bytes: number }[];
  /** Checkouts left whole because they hold work that isn't on a remote. */
  kept: { path: string; why: string }[];
  failed: { path: string; error: string }[];
};

/** What kind of regenerable thing this folder is, or null. `parent` is the folder it's in. */
function regenerable(dir: string, name: string, parent: string): string | null {
  if (REGENERABLE.has(name)) return name;
  if ((name === "cache" || name === "unplugged") && basename(parent) === ".yarn") return `.yarn/${name}`;
  if (BUILD_OUTPUT.has(name) && MANIFESTS.some((m) => existsSync(join(parent, m)))) return "build output";
  if (existsSync(join(dir, "pyvenv.cfg"))) return "Python venv";
  if (ANDROID_SDK_PARTS.filter((p) => existsSync(join(dir, p))).length >= 2) return "Android SDK";
  if (existsSync(join(dir, "release")) && existsSync(join(dir, "bin", "java"))) return "JDK";
  // IDF_TOOLS_PATH (~/.espressif by default): compilers and a venv that ESP-IDF's install.sh downloads.
  if (existsSync(join(dir, "idf-env.json"))) return "ESP-IDF tools";
  return null;
}

/** Disk use in bytes, as du counts it (what removing it frees). 0 if it can't tell. */
export async function diskBytes(path: string): Promise<number> {
  try {
    const { stdout } = await run("du", ["-sk", path], { timeout: 120_000 });
    return (Number.parseInt(stdout, 10) || 0) * 1024;
  } catch {
    return 0;
  }
}

async function isIgnored(repo: string, path: string): Promise<boolean> {
  return run("git", ["-C", repo, "check-ignore", "-q", relative(repo, path)], { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * Clear the regenerable bulk out of `root` (never `root` itself). Symlinks
 * aren't followed, so nothing outside the folder is touched. `dryRun` only
 * reports what would go.
 */
export async function slimFolder(root: string, opts: { dryRun?: boolean } = {}): Promise<SlimOutcome> {
  const outcome: SlimOutcome = { removed: [], kept: [], failed: [] };

  const remove = async (path: string, what: string, removeFn: () => Promise<void>) => {
    const bytes = await diskBytes(path);
    try {
      if (!opts.dryRun) await removeFn();
      outcome.removed.push({ path, what, bytes });
    } catch (err) {
      outcome.failed.push({ path, error: err instanceof Error ? err.message.split("\n")[0]! : String(err) });
    }
  };

  /** `repo`: the checkout this folder is inside, if any. In one, only what git ignores may go. */
  const walk = async (dir: string, repo: string | null): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === ".git") continue;
      const path = join(dir, e.name);
      if (existsSync(join(path, ".git"))) {
        const why = await unsavedWork(path);
        if (why) {
          outcome.kept.push({ path, why });
          await walk(path, path);
        } else {
          await remove(path, "clone", () => removeCheckout(path));
        }
        continue;
      }
      const what = regenerable(path, e.name, dir);
      if (what && (!repo || (await isIgnored(repo, path)))) {
        await remove(path, what, () => rm(path, { recursive: true, force: true }));
        continue;
      }
      await walk(path, repo);
    }
  };

  const rootIsRepo = await lstat(join(root, ".git")).then(
    () => true,
    () => false,
  );
  await walk(root, rootIsRepo ? root : null);
  return outcome;
}

/**
 * The transcript's account of a slimming: what it freed, what it kept that
 * might be the only copy, and what it couldn't remove. Paths are shown
 * relative to `root`.
 */
export function slimNotices(outcome: SlimOutcome, root: string): { text: string; level: "info" | "warn" }[] {
  const name = (p: string) => (p.startsWith(root) ? relative(root, p) : basename(p));
  const notices: { text: string; level: "info" | "warn" }[] = [];
  if (outcome.removed.length > 0) {
    const total = outcome.removed.reduce((n, r) => n + r.bytes, 0);
    const groups = new Map<string, string[]>();
    for (const r of outcome.removed) groups.set(r.what, [...(groups.get(r.what) ?? []), name(r.path)]);
    const parts = [...groups].map(([what, names]) => {
      const label = what === "clone" ? "checkouts with everything on GitHub" : what;
      const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
      return `${label} (${shown})`;
    });
    notices.push({ text: `Archiving freed ${formatBytes(total)}: ${parts.join("; ")}. Unarchiving doesn't bring these back.`, level: "info" });
  }
  for (const k of outcome.kept) notices.push({ text: `Kept ${name(k.path)}, which may be the only copy: ${k.why}.`, level: "info" });
  for (const f of outcome.failed) notices.push({ text: `Couldn't remove ${name(f.path)} when archiving: ${f.error}`, level: "warn" });
  return notices;
}

/** "1.2 GB", "340 MB", "12 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
