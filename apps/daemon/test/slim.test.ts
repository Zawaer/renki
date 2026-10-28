import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { formatBytes, slimFolder, slimNotices } from "../src/sessions/slim.js";
import { cleanupConfig, makeTestConfig, makeTestRepo } from "./helpers.js";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" }).toString().trim();

const created: Config[] = [];
afterEach(() => {
  for (const c of created.splice(0)) cleanupConfig(c);
});

function file(path: string, content = "x"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** A chat folder shaped like the GNSS hackathon one on the homelab. */
function chatFolder() {
  const config = makeTestConfig();
  created.push(config);
  const chat = resolve(config.dataDir, "chats", "s_aaaaaaaaaa");
  // A pushed project, cloned in to work on.
  const { repoPath: upstream } = makeTestRepo(config.reposRoot, "parvi");
  const bare = resolve(config.dataDir, "parvi.git");
  git(config.dataDir, "clone", "-q", "--bare", upstream, bare);
  git(config.dataDir, "clone", "-q", bare, resolve(chat, "parvi"));
  // Something Claude started here and never pushed anywhere.
  const local = resolve(chat, "datakeskus");
  file(resolve(local, "server.js"));
  file(resolve(local, ".gitignore"), "node_modules/\n");
  git(chat, "init", "-q", local);
  file(resolve(local, "node_modules", "dep", "index.js"));
  // Loose files and folders, no git.
  file(resolve(chat, "notes.md"));
  file(resolve(chat, "ais-data", "positions.csv"));
  file(resolve(chat, "qa-shots", "home.png"));
  file(resolve(chat, "qa", "package.json"), "{}");
  file(resolve(chat, "qa", "node_modules", "dep", "index.js"));
  file(resolve(chat, "qa", "dist", "bundle.js"));
  file(resolve(chat, "android-sdk", "platforms", "android-34", "android.jar"));
  file(resolve(chat, "android-sdk", "build-tools", "34.0.0", "aapt"));
  file(resolve(chat, "renders", "build", "frame.png"));
  file(resolve(chat, ".idf", "tools", "idf-env.json"), "{}");
  file(resolve(chat, ".idf", "tools", "tools", "xtensa", "gcc"));
  file(resolve(chat, "py", "idf5.5_py3.11_env", "pyvenv.cfg"));
  return { chat };
}

describe("slimFolder", () => {
  it("clears installs, builds, SDKs and pushed clones, and keeps everything that may be the only copy", async () => {
    const { chat } = chatFolder();

    const outcome = await slimFolder(chat);

    const gone = ["parvi", "qa/node_modules", "qa/dist", "android-sdk", "datakeskus/node_modules", ".idf/tools", "py/idf5.5_py3.11_env"];
    for (const p of gone) expect(existsSync(resolve(chat, p)), p).toBe(false);
    const stays = ["notes.md", "ais-data/positions.csv", "qa-shots/home.png", "qa/package.json", "datakeskus/server.js", "renders/build/frame.png"];
    for (const p of stays) expect(existsSync(resolve(chat, p)), p).toBe(true);

    expect(outcome.removed.map((r) => [r.what, r.path.slice(chat.length + 1)]).sort()).toEqual([
      ["Android SDK", "android-sdk"],
      ["ESP-IDF tools", ".idf/tools"],
      ["Python venv", "py/idf5.5_py3.11_env"],
      ["build output", "qa/dist"],
      ["clone", "parvi"],
      ["node_modules", "datakeskus/node_modules"],
      ["node_modules", "qa/node_modules"],
    ]);
    expect(outcome.kept).toEqual([{ path: resolve(chat, "datakeskus"), why: "its repo has no remote to check against" }]);
    expect(outcome.failed).toEqual([]);
  });

  it("only reports in a dry run", async () => {
    const { chat } = chatFolder();
    const outcome = await slimFolder(chat, { dryRun: true });
    expect(outcome.removed).toHaveLength(7);
    for (const r of outcome.removed) expect(existsSync(r.path), r.path).toBe(true);
  });

  it("removes inside a checkout only what git ignores", async () => {
    const config = makeTestConfig();
    created.push(config);
    const { repoPath } = makeTestRepo(config.dataDir, "chat");
    file(resolve(repoPath, "package.json"), "{}");
    file(resolve(repoPath, ".gitignore"), "node_modules/\n");
    file(resolve(repoPath, "node_modules", "dep", "index.js"));
    file(resolve(repoPath, "dist", "bundle.js"));

    await slimFolder(repoPath);

    expect(existsSync(resolve(repoPath, "node_modules"))).toBe(false);
    // Not ignored, so as far as git knows it's work: it stays.
    expect(existsSync(resolve(repoPath, "dist", "bundle.js"))).toBe(true);
  });
});

describe("slimNotices", () => {
  it("says what was freed, what was kept and what failed", () => {
    const root = "/data/chats/s_a";
    const notices = slimNotices(
      {
        removed: [
          { path: `${root}/android-sdk`, what: "Android SDK", bytes: 436 * 1024 ** 2 },
          { path: `${root}/parvi`, what: "clone", bytes: 359 * 1024 ** 2 },
          { path: `${root}/crns`, what: "clone", bytes: 20 * 1024 ** 2 },
          { path: "/data/mac-artifacts/s_a", what: "Mac build artifacts", bytes: 99 * 1024 ** 2 },
        ],
        kept: [{ path: `${root}/datakeskus`, why: "its repo has no remote to check against" }],
        failed: [{ path: `${root}/qa/node_modules`, error: "EACCES: permission denied" }],
      },
      root,
    );

    expect(notices).toEqual([
      {
        text: "Archiving freed 914 MB: Android SDK (android-sdk); checkouts with everything on GitHub (parvi, crns); Mac build artifacts (s_a). Unarchiving doesn't bring these back.",
        level: "info",
      },
      { text: "Kept datakeskus, which may be the only copy: its repo has no remote to check against.", level: "info" },
      { text: "Couldn't remove qa/node_modules when archiving: EACCES: permission denied", level: "warn" },
    ]);
  });

  it("says nothing when there was nothing to clear", () => {
    expect(slimNotices({ removed: [], kept: [], failed: [] }, "/x")).toEqual([]);
  });

  it("formats sizes the way people read them", () => {
    expect(formatBytes(1.6 * 1024 ** 3)).toBe("1.6 GB");
    expect(formatBytes(340 * 1024 ** 2)).toBe("340 MB");
    expect(formatBytes(100)).toBe("1 KB");
  });
});
