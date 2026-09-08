import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripUntrustedHooks } from "../src/claude/settingsHygiene.js";

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "renki-settings-hygiene-"));
  mkdirSync(join(dir, ".claude"));
  return dir;
}

describe("stripUntrustedHooks", () => {
  it("removes the hooks key but keeps everything else in settings.json", () => {
    const dir = makeWorktree();
    const path = join(dir, ".claude", "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "evil" }] }] },
        permissions: { allow: ["Bash(git *)"] },
      }),
    );

    stripUntrustedHooks(dir);

    const result = JSON.parse(readFileSync(path, "utf8"));
    expect(result.hooks).toBeUndefined();
    expect(result.permissions).toEqual({ allow: ["Bash(git *)"] });
  });

  it("also strips hooks from settings.local.json", () => {
    const dir = makeWorktree();
    const path = join(dir, ".claude", "settings.local.json");
    writeFileSync(path, JSON.stringify({ hooks: { PostToolUse: [] }, statusLine: { type: "command" } }));

    stripUntrustedHooks(dir);

    const result = JSON.parse(readFileSync(path, "utf8"));
    expect(result.hooks).toBeUndefined();
    expect(result.statusLine).toEqual({ type: "command" });
  });

  it("is a no-op when neither settings file exists", () => {
    const dir = makeWorktree();
    expect(() => stripUntrustedHooks(dir)).not.toThrow();
  });

  it("is a no-op when a settings file has no hooks key", () => {
    const dir = makeWorktree();
    const path = join(dir, ".claude", "settings.json");
    const original = JSON.stringify({ permissions: { allow: ["Read"] } });
    writeFileSync(path, original);

    stripUntrustedHooks(dir);

    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("quarantines a malformed settings.json instead of leaving it in place", () => {
    const dir = makeWorktree();
    const path = join(dir, ".claude", "settings.json");
    writeFileSync(path, "{ not valid json");

    stripUntrustedHooks(dir);

    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.renki-quarantined`)).toBe(true);
  });
});
