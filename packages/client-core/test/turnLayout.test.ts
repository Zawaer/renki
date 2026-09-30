import type { Session } from "@renki/protocol";
import { describe, expect, it } from "vitest";
import type { BlockView, TimelineItem, TurnView } from "../src/reducer.js";
import { backgroundTasksOf, groupTurnBlocks, sessionsNeedingAttention, summarizeSteps, turnFileChanges } from "../src/turnLayout.js";

const tool = (toolName: string, toolInput: unknown, extra: Partial<Extract<BlockView, { kind: "tool_use" }>> = {}): BlockView => ({
  kind: "tool_use",
  toolUseId: `tu_${Math.random().toString(36).slice(2)}`,
  toolName,
  toolInput,
  result: { ok: true, summary: "" },
  ...extra,
});
const text = (t: string): BlockView => ({ kind: "text", text: t, startedAtMs: null, endedAtMs: null } as BlockView);
const thinking = (): BlockView => ({ kind: "thinking", text: "", startedAtMs: null, endedAtMs: null } as BlockView);

describe("groupTurnBlocks", () => {
  it("folds a run of routine calls into one group, keeping text apart", () => {
    const segs = groupTurnBlocks([text("Looking"), tool("Bash", { command: "ls" }), thinking(), tool("Read", { file_path: "/a.ts" }), text("Done")]);
    expect(segs.map((s) => s.kind)).toEqual(["block", "group", "block"]);
    const group = segs[1]!;
    if (group.kind !== "group") throw new Error("expected group");
    expect(group.items.map((i) => i.index)).toEqual([1, 2, 3]);
    expect(group.summary.text).toBe("Ran 1 command, read 1 file");
  });

  it("leaves a single call, and thinking at either end, on their own lines", () => {
    const segs = groupTurnBlocks([thinking(), tool("Bash", { command: "ls" }), thinking(), text("ok")]);
    expect(segs.map((s) => s.kind)).toEqual(["block", "block", "block", "block"]);
  });

  it("never folds an agent, a plan or a task list", () => {
    const segs = groupTurnBlocks([tool("Bash", {}), tool("Agent", { description: "Explore" }), tool("Bash", {})]);
    expect(segs.map((s) => s.kind)).toEqual(["block", "block", "block"]);
  });

  it("breaks a run where a steered prompt renders", () => {
    const blocks = [tool("Bash", {}), tool("Bash", {}), tool("Bash", {}), tool("Bash", {})];
    const segs = groupTurnBlocks(blocks, new Set([1]));
    expect(segs.map((s) => (s.kind === "group" ? s.items.map((i) => i.index) : s.index))).toEqual([[0, 1], [2, 3]]);
  });

  it("skips holes in the block list", () => {
    const blocks: BlockView[] = [];
    blocks[0] = tool("Bash", {});
    blocks[2] = tool("Bash", {});
    expect(groupTurnBlocks(blocks)).toHaveLength(1);
  });
});

describe("summarizeSteps", () => {
  it("counts files, not calls, and totals the diff", () => {
    const s = summarizeSteps([
      tool("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y\nz" }),
      tool("Edit", { file_path: "/a.ts", old_string: "p", new_string: "q" }),
      tool("Bash", { command: "npm test" }, { result: { ok: false, summary: "1 failed" } }),
    ]);
    expect(s.text).toBe("Edited 1 file, ran 1 command");
    expect(s.added).toBe(3);
    expect(s.removed).toBe(2);
    expect(s.failed).toBe(1);
  });

  it("says what the newest call is doing while it runs", () => {
    const s = summarizeSteps([tool("Bash", { command: "ls" }), tool("Bash", { command: "npm test", description: "Run the tests" }, { result: null })]);
    expect(s).toMatchObject({ running: true, current: "Run the tests" });
  });
});

describe("turnFileChanges", () => {
  it("adds up each file across edits, agents included, and skips failed edits", () => {
    const agent = tool("Agent", {}, {
      subagent: { subagentType: null, taskDescription: null, status: "done", blocks: [tool("Write", { file_path: "/b.md", content: "one\ntwo" })] },
    });
    const turn = {
      blocks: [
        tool("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" }),
        tool("Edit", { file_path: "/a.ts", old_string: "p", new_string: "q" }, { result: { ok: false, summary: "no match" } }),
        agent,
      ],
    } as TurnView;
    expect(turnFileChanges(turn).map(({ filePath, added, removed }) => ({ filePath, added, removed }))).toEqual([
      { filePath: "/a.ts", added: 1, removed: 1 },
      { filePath: "/b.md", added: 2, removed: 0 },
    ]);
  });
});

describe("backgroundTasksOf", () => {
  it("lists backgrounded calls, agents' too, newest first, with their outcome", () => {
    const inner = tool("Bash", { run_in_background: true, description: "Load the page" }, { backgroundTask: { status: "failed", summary: "timed out" } });
    const timeline: TimelineItem[] = [
      { type: "turn", turn: { blocks: [tool("Bash", { run_in_background: true, description: "Run tests" })] } as TurnView },
      {
        type: "turn",
        turn: {
          blocks: [
            tool("Agent", { description: "Research" }, {
              backgroundTask: { status: "completed", summary: "done" },
              subagent: { subagentType: null, taskDescription: null, status: "done", blocks: [inner] },
            }),
            tool("Bash", { command: "ls" }),
          ],
        } as TurnView,
      },
    ];
    expect(backgroundTasksOf(timeline).map((t) => [t.label, t.kind, t.status])).toEqual([
      ["Load the page", "command", "failed"],
      ["Research", "agent", "completed"],
      ["Run tests", "command", "running"],
    ]);
  });
});

describe("sessionsNeedingAttention", () => {
  const s = (id: string, extra: Partial<Session>): Session =>
    ({ id, status: "idle", hasPendingPermission: false, lastActivityAt: 0, resume: null, ...extra }) as Session;

  it("puts approvals first, then errors, then pauses, and skips the rest", () => {
    const list = sessionsNeedingAttention([
      s("paused", { resume: { at: 1, reason: "", attempt: 0 } }),
      s("fine", {}),
      s("err", { status: "error" }),
      s("ask", { status: "busy", hasPendingPermission: true }),
      s("gone", { status: "archived", hasPendingPermission: true }),
    ]);
    expect(list.map((x) => [x.session.id, x.reason])).toEqual([
      ["ask", "permission"],
      ["err", "error"],
      ["paused", "paused"],
    ]);
  });
});
