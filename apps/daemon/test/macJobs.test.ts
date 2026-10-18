import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MacJobs, ManifestError, buildManifest } from "../src/mac/jobs.js";
import { MAC_BUILD_TOOL, createMacApprovalHook } from "../src/mac/tools.js";

const dir = mkdtempSync(join(tmpdir(), "renki-macjobs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function repo() {
  const r = mkdtempSync(join(dir, "repo-"));
  execFileSync("git", ["init", "-q", r]);
  writeFileSync(join(r, ".gitignore"), "node_modules/\nbuild/\n");
  writeFileSync(join(r, "tracked.ts"), "x");
  writeFileSync(join(r, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  execFileSync("git", ["-C", r, "add", "."]);
  writeFileSync(join(r, "new.ts"), "untracked but not ignored");
  mkdirSync(join(r, "node_modules"));
  writeFileSync(join(r, "node_modules", "dep.js"), "ignored");
  symlinkSync("/etc/hosts", join(r, "link"));
  return r;
}

describe("buildManifest", () => {
  it("mirrors tracked and new files, but not ignored ones or symlinks", async () => {
    const r = repo();
    const m = await buildManifest(r);
    expect(m.map((e) => e.p).sort()).toEqual([".gitignore", "new.ts", "run.sh", "tracked.ts"]);
    expect(m.find((e) => e.p === "run.sh")?.x).toBe(true);
    expect(m.find((e) => e.p === "tracked.ts")?.h).toBe("11f6ad8ec52a2984abaafd7c3b516503785c2072");
  });

  it("explains a folder that isn't a repo", async () => {
    await expect(buildManifest(mkdtempSync(join(dir, "plain-")))).rejects.toBeInstanceOf(ManifestError);
  });
});

describe("MacJobs", () => {
  it("hands out only the job's own files, and only while it is open", async () => {
    const r = repo();
    const jobs = new MacJobs(join(dir, "artifacts"));
    const { id } = jobs.open(r, "s_1", await buildManifest(r));
    expect(jobs.fileFor(id, "tracked.ts")).toBe(join(r, "tracked.ts"));
    expect(jobs.fileFor(id, "link")).toBeNull();
    expect(jobs.fileFor(id, "node_modules/dep.js")).toBeNull();
    expect(jobs.fileFor(id, "../outside")).toBeNull();
    expect(jobs.fileFor("other", "tracked.ts")).toBeNull();
    jobs.close(id);
    expect(jobs.fileFor(id, "tracked.ts")).toBeNull();
  });

  it("accepts plain artifact names only, and a limited number", async () => {
    const r = repo();
    const jobs = new MacJobs(join(dir, "artifacts"));
    const { id, artifactDir } = jobs.open(r, "s_1", []);
    expect(jobs.artifactPath(id, "../../etc/x")).toBeNull();
    expect(jobs.artifactPath(id, ".hidden")).toBeNull();
    expect(jobs.artifactPath(id, "app-debug.apk")).toBe(join(artifactDir, "app-debug.apk"));
    for (let i = 0; i < 20; i++) jobs.artifactPath(id, `f${i}`);
    expect(jobs.artifactPath(id, "late.apk")).toBeNull();
  });
});

describe("mac_build approval", () => {
  const run = (input: object) =>
    createMacApprovalHook().hooks[0]!({ hook_event_name: "PreToolUse", tool_name: MAC_BUILD_TOOL, tool_input: input } as never, undefined, {
      signal: new AbortController().signal,
    });

  it("asks only when the build is to be installed on the phone", async () => {
    expect(await run({ job: "android-debug" })).toEqual({ continue: true });
    expect(await run({ job: "android-debug", install: true })).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
  });
});
