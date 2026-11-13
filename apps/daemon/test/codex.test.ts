import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCodex } from "../src/claude/codex.js";

/** A stand-in `codex`: behaves per the MODE env var, records its argv and stdin. */
function stub(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-stub-"));
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.STUB_LOG, JSON.stringify({ argv, input }));
  const mode = process.env.MODE;
  if (mode === "hang") return setInterval(() => {}, 1000);
  const out = argv[argv.indexOf("-o") + 1];
  console.log(JSON.stringify({ type: "thread.started", thread_id: "th_1" }));
  if (mode === "fail") {
    console.log(JSON.stringify({ type: "error", message: "not logged in" }));
    process.exit(1);
  }
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
  fs.writeFileSync(out, "Found it: off by one in loop.ts:12\\n");
});
`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

describe("runCodex", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  function setup(mode: string) {
    const dir = stub();
    process.env.RENKI_CODEX_BIN = join(dir, "codex");
    process.env.STUB_LOG = join(dir, "log.json");
    process.env.MODE = mode;
    return () => JSON.parse(require("node:fs").readFileSync(join(dir, "log.json"), "utf8")) as { argv: string[]; input: string };
  }

  it("returns Codex's final answer, with the run id and tokens, and passes the brief on stdin", async () => {
    const log = setup("ok");
    const r = await runCodex({ prompt: "Find the bug", cwd: tmpdir() });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Found it: off by one in loop.ts:12");
    expect(r.text).toContain("th_1");
    expect(r.text).toContain("10 tokens in, 5 out");
    const { argv, input } = log();
    expect(input).toBe("Find the bug");
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv.slice(argv.indexOf("-C"), argv.indexOf("-C") + 2)).toEqual(["-C", tmpdir()]);
  });

  it("asks for Codex's read-only sandbox when readOnly is set", async () => {
    const log = setup("ok");
    await runCodex({ prompt: "Review", cwd: tmpdir(), readOnly: true, model: "gpt-5-codex" });
    const { argv } = log();
    expect(argv).toEqual(expect.arrayContaining(["-s", "read-only", "-m", "gpt-5-codex"]));
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("says why when Codex fails", async () => {
    setup("fail");
    const r = await runCodex({ prompt: "x", cwd: tmpdir() });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("not logged in");
  });

  it("stops Codex when the call is aborted", async () => {
    setup("hang");
    const ac = new AbortController();
    const p = runCodex({ prompt: "x", cwd: tmpdir() }, ac.signal);
    setTimeout(() => ac.abort(), 300);
    const r = await p;
    expect(r).toEqual({ ok: false, text: "Stopped." });
  });
});
