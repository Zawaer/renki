import type { EventPayload, ExportOptions, Session, SessionEvent } from "@renki/protocol";
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { ExportError, exportChat, slug } from "../src/export/index.js";

const T0 = Date.parse("2026-10-08T09:00:00Z");
/** A real 64×40 amber PNG, so the PDF test shows an image actually renders. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAWUlEQVR4nO3PUQkAIBTAwNfRfDY0hCH8OITBAtzm7PV1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBZtaZD7qb1csAAAAASUVORK5CYII=";

const session: Session = {
  id: "s1",
  repoId: "r1",
  repoName: "renki",
  baseBranch: "main",
  branch: "renki/abc123",
  worktreePath: "/tmp/s1",
  status: "idle",
  hasPendingPermission: false,
  controller: null,
  claudeSessionId: null,
  title: "Fix the `export` button!",
  createdAt: T0,
  updatedAt: T0,
  lastActivityAt: T0,
} as Session;

function events(): SessionEvent[] {
  const payloads: EventPayload[] = [
    { kind: "session_created", repoId: "r1", repoName: "renki", baseBranch: "main", branch: "renki/abc123", worktreePath: "/tmp/s1", purpose: "normal", mergeMeta: null } as EventPayload,
    { kind: "prompt_submitted", promptId: "p1", deviceId: "web_1", text: "Why is the export button grey?", attachments: [{ name: "shot.png", mediaType: "image/png", data: PNG }] },
    { kind: "turn_started", turnId: "t1", promptId: "p1", trigger: "prompt" },
    { kind: "assistant_block", turnId: "t1", blockIndex: 0, blockKind: "thinking", text: "Probably the disabled prop.", toolUseId: null, toolName: null, toolInput: null },
    { kind: "assistant_block", turnId: "t1", blockIndex: 1, blockKind: "tool_use", text: null, toolUseId: "u1", toolName: "Bash", toolInput: { command: "grep -rn disabled src", description: "Find the disabled prop" } },
    { kind: "tool_result", turnId: "t1", toolUseId: "u1", ok: true, summary: "src/Export.tsx:12: disabled={true}", images: [{ name: "screen.png", mediaType: "image/png", data: PNG }] },
    { kind: "assistant_block", turnId: "t1", blockIndex: 2, blockKind: "text", text: "It's hard-coded `disabled={true}` in Export.tsx.", toolUseId: null, toolName: null, toolInput: null },
    { kind: "turn_result", turnId: "t1", promptId: "p1", ok: true, costUsd: 0.42, durationMs: 65_000, errorMessage: null, inputTokens: 1000, cachedInputTokens: 20_000, outputTokens: 500 },
    { kind: "notice", text: "Switched account.", level: "info" },
  ];
  return payloads.map((p, i) => ({ ...p, seq: i, sessionId: "s1", ts: T0 + i * 60_000 }) as SessionEvent);
}

const opts = (over: Partial<ExportOptions> = {}): ExportOptions => ({
  format: "markdown",
  media: true,
  tools: true,
  thinking: false,
  stats: false,
  timeZone: "Europe/Helsinki",
  ...over,
});

describe("exportChat (markdown)", () => {
  it("writes the conversation with timestamps, tool calls and their output, and no thinking by default", async () => {
    const file = await exportChat(session, events(), opts({ media: false }), T0);
    expect(file.filename).toBe("fix-the-export-button-2026-10-08.md");
    const md = file.body.toString("utf8");
    expect(md).toMatch(/^# Fix the `export` button!/);
    expect(md).toContain("### You · Thu, 8 Oct 2026, 12:01"); // Helsinki is UTC+3
    expect(md).toContain("Why is the export button grey?");
    expect(md).toContain("_Attached: shot.png_");
    expect(md).toContain("**Find the disabled prop**");
    expect(md).toContain("grep -rn disabled src");
    expect(md).toContain("src/Export.tsx:12: disabled={true}");
    expect(md).toContain("It's hard-coded `disabled={true}` in Export.tsx.");
    expect(md).toContain("Switched account.");
    expect(md).not.toContain("Probably the disabled prop.");
    expect(md).not.toContain("$0.42");
  });

  it("leaves tool calls out, and puts thinking and stats in, when asked", async () => {
    const md = (await exportChat(session, events(), opts({ media: false, tools: false, thinking: true, stats: true }), T0)).body.toString("utf8");
    expect(md).not.toContain("grep -rn disabled src");
    expect(md).not.toContain("disabled={true}`\n```"); // no tool output fence
    expect(md).toContain("> Probably the disabled prop.");
    expect(md).toContain("1m 5s · 22k tokens · $0.42");
    expect(md).toContain("It's hard-coded");
  });

  it("zips the markdown with a media folder when there's media to include", async () => {
    const file = await exportChat(session, events(), opts(), T0);
    expect(file.filename).toBe("fix-the-export-button-2026-10-08.zip");
    const entries = unzipSync(new Uint8Array(file.body));
    const base = "fix-the-export-button-2026-10-08";
    expect(Object.keys(entries).sort()).toEqual([`${base}/${base}.md`, `${base}/media/001-shot.png`, `${base}/media/002-screen.png`]);
    const md = strFromU8(entries[`${base}/${base}.md`]!);
    expect(md).toContain("![shot.png](media/001-shot.png)");
    expect(md).toContain("![screen.png](media/002-screen.png)");
    expect(Buffer.from(entries[`${base}/media/001-shot.png`]!).toString("base64")).toBe(PNG);
  });

  it("names files safely", () => {
    expect(slug("  Ünïcode & spaces / slashes  ")).toBe("unicode-spaces-slashes");
    expect(slug("???")).toBe("chat");
  });
});

describe("exportChat (pdf)", () => {
  it("renders a PDF, or says plainly why it can't on this host", async () => {
    try {
      const file = await exportChat(session, events(), opts({ format: "pdf" }), T0);
      expect(file.filename).toBe("fix-the-export-button-2026-10-08.pdf");
      expect(file.body.subarray(0, 5).toString()).toBe("%PDF-");
    } catch (err) {
      expect(err).toBeInstanceOf(ExportError);
      expect((err as ExportError).message).toMatch(/Markdown export still works/);
    }
  }, 60_000);
});
