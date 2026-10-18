import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real wrapper script, run against a throwaway HOME (it works under $HOME/work).
let bundle: string;
let home: string;
let outside: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "renki-wrapper-test-"));
  bundle = join(dir, "renki-runner.mjs");
  execFileSync("npx", ["esbuild", "src/runner-wrapper.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`, "--log-level=error"]);
  home = join(dir, "home");
  outside = join(dir, "secret.txt");
  mkdirSync(home);
  writeFileSync(outside, "the user's secret");
});
afterAll(() => rmSync(join(bundle, ".."), { recursive: true, force: true }));

function wrapper(args: string[], stdin: Buffer | string = "") {
  const r = spawnSync(process.execPath, [bundle, ...args], { input: stdin, env: { HOME: home, PATH: process.env.PATH }, timeout: 20_000 });
  return { code: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const entry = (p: string, body: string, x = false) => ({ p, h: sha(body), x });
function bundleOf(manifest: object[], files: Record<string, string>) {
  const frames = Object.entries(files).map(([p, b]) => `${JSON.stringify({ p, n: Buffer.byteLength(b) })}\n${b}`);
  return Buffer.from(`${JSON.stringify(manifest)}\n${frames.join("")}`);
}

describe("renki-runner.mjs", () => {
  it("syncs only what changed, keeps the exec bit, and removes deleted files", () => {
    const m1 = [entry("a.txt", "one"), entry("src/run.sh", "#!/bin/sh\necho hi\n", true)];
    expect(JSON.parse(wrapper(["diff", "proj"], JSON.stringify(m1)).out)).toEqual(["a.txt", "src/run.sh"]);
    const r = wrapper(["apply", "proj"], bundleOf(m1, { "a.txt": "one", "src/run.sh": "#!/bin/sh\necho hi\n" }));
    expect(r.code, r.err).toBe(0);
    const root = join(home, "work", "proj");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one");
    expect(statSync(join(root, "src/run.sh")).mode & 0o111).not.toBe(0);

    const m2 = [entry("src/run.sh", "#!/bin/sh\necho hi\n", true)];
    expect(JSON.parse(wrapper(["diff", "proj"], JSON.stringify(m2)).out)).toEqual([]);
    expect(wrapper(["apply", "proj"], bundleOf(m2, {})).code).toBe(0);
    expect(existsSync(join(root, "a.txt"))).toBe(false);
  });

  it("refuses a file whose content doesn't match the manifest, or that isn't in it", () => {
    const m = [entry("b.txt", "expected")];
    expect(wrapper(["apply", "proj"], bundleOf(m, { "b.txt": "tampered" })).err).toMatch(/changed on the homelab/);
    expect(wrapper(["apply", "proj"], bundleOf(m, { "c.txt": "x" })).err).toMatch(/isn't in the manifest/);
  });

  it("never follows a symlink a build left in the mirror", () => {
    const root = join(home, "work", "proj");
    symlinkSync(outside, join(root, "leak.txt"));
    symlinkSync(join(outside, ".."), join(root, "linkdir"));
    // Exporting through it is refused, so nothing outside the mirror is read.
    expect(wrapper(["export", "proj", "leak.txt"]).code).not.toBe(0);
    expect(wrapper(["export", "proj", "linkdir/secret.txt"]).err).toMatch(/symlink/);
    // Writing to it replaces the link itself, never the file it points to.
    const m = [entry("src/run.sh", "#!/bin/sh\necho hi\n", true), entry("leak.txt", "new")];
    expect(wrapper(["apply", "proj"], bundleOf(m, { "leak.txt": "new" })).code).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("the user's secret");
    expect(wrapper(["apply", "proj"], bundleOf([entry("linkdir/x", "y")], { "linkdir/x": "y" })).err).toMatch(/symlink/);
  });

  it("rejects paths and names that try to leave the project", () => {
    for (const p of ["../x", "/etc/passwd", "a/../../x", "a//b"]) {
      expect(wrapper(["diff", "proj"], JSON.stringify([{ p, h: sha(""), x: false }])).code, p).not.toBe(0);
    }
    expect(wrapper(["diff", "../proj"], "[]").err).toMatch(/bad project/);
    expect(wrapper(["export", "proj", "../../secret.txt"]).err).toMatch(/bad path/);
  });

  it("runs a command in the mirror with a clean environment, and streams a file out", () => {
    const r = spawnSync(process.execPath, [bundle, "run", "proj", "src", "30", "pwd; echo ${RENKI_SECRET:-clean}; echo $CI"], {
      env: { HOME: home, PATH: process.env.PATH, RENKI_SECRET: "leaked" },
    });
    expect(r.stdout.toString().trim().split("\n")).toEqual([expect.stringContaining("work/proj/src"), "clean", "1"]);
    expect(wrapper(["export", "proj", "src/run.sh"]).out).toBe("#!/bin/sh\necho hi\n");
  });

  it("stops a job at its timeout", () => {
    const r = wrapper(["run", "proj", ".", "10", "sleep 30"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/timed out/);
  }, 30_000);
});
