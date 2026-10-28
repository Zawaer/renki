import type { Session } from "@renki/protocol";
import { describe, expect, it } from "vitest";
import type { BlockView, TimelineItem, TurnView } from "../src/reducer.js";
import { agentMapOf, backgroundTasksOf, backgroundWorkOf, flattenAgents, groupTurnBlocks, segmentImages, sessionsNeedingAttention, suggestedReplies, summarizeSteps, turnActivity, turnFileChanges, turnTodos } from "../src/turnLayout.js";

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

  it("never folds an agent or a plan", () => {
    const segs = groupTurnBlocks([tool("Bash", {}), tool("Agent", { description: "Explore" }), tool("Bash", {}), tool("ExitPlanMode", { plan: "x" })]);
    expect(segs.map((s) => s.kind)).toEqual(["block", "block", "block", "block"]);
  });

  it("folds task list updates in with the steps around them", () => {
    const segs = groupTurnBlocks([tool("Bash", {}), tool("TodoWrite", { todos: [] }), tool("Bash", {})]);
    expect(segs).toHaveLength(1);
    const group = segs[0]!;
    if (group.kind !== "group") throw new Error("expected group");
    expect(group.summary.text).toBe("Ran 2 commands, updated tasks");
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

describe("segmentImages", () => {
  const shot = (n: number) => ({ name: `image-${n}.png`, mediaType: "image/png" as const, data: "AAAA" });

  it("collects the images of every call in a group, in order", () => {
    const segs = groupTurnBlocks([
      tool("Bash", { command: "ls" }),
      tool("Read", { file_path: "/a.png" }, { result: { ok: true, summary: "", images: [shot(1)] } }),
      tool("Read", { file_path: "/b.png" }, { result: { ok: true, summary: "", images: [shot(2), shot(3)] } }),
    ]);
    expect(segs).toHaveLength(1);
    expect(segmentImages(segs[0]!).map((i) => i.name)).toEqual(["image-1.png", "image-2.png", "image-3.png"]);
  });

  it("finds none on text, a call without images, or one still running", () => {
    const segs = groupTurnBlocks([text("hi"), tool("Bash", { command: "ls" }), text("x"), tool("Bash", { command: "ls" }, { result: null })]);
    expect(segs.flatMap(segmentImages)).toEqual([]);
  });
});

describe("agentMapOf", () => {
  it("nests the agents an agent started, with status, type and a clean answer", () => {
    const child = tool("Agent", { description: "Check docs", subagent_type: "Explore" }, { toolUseId: "tu_child", result: null });
    const timeline: TimelineItem[] = [
      {
        type: "turn",
        turn: {
          status: "done",
          blocks: [
            tool("Agent", { description: "Research", subagent_type: "general-purpose" }, {
              toolUseId: "tu_parent",
              startedAtMs: 1000,
              agentUsage: { tokens: 5000, toolUses: 3, durationMs: 2000 },
              result: { ok: true, summary: "Found it.\nagentId: abc (use SendMessage)\n<usage>total_tokens: 5000\ntool_uses: 3</usage>" },
              subagent: { subagentType: "general-purpose", taskDescription: "Research", status: "done", blocks: [child, tool("Bash", { command: "ls" })] },
            }),
            tool("Bash", { command: "ls" }),
            tool("Agent", { description: "Watch CI", run_in_background: true }, { toolUseId: "tu_bg", result: { ok: true, summary: "Launched" } }),
          ],
        } as TurnView,
      },
    ];
    const map = agentMapOf(timeline);
    expect(map.map((a) => [a.toolUseId, a.type, a.status, a.background])).toEqual([
      ["tu_parent", "general-purpose", "done", false],
      ["tu_bg", "Agent", "running", true],
    ]);
    expect(map[0]!.summary).toBe("Found it.");
    expect(map[0]!.usage?.tokens).toBe(5000);
    expect(map[0]!.startedAtMs).toBe(1000);
    // Its turn is over and the child never answered: stopped, not running forever.
    expect(map[0]!.children.map((c) => [c.label, c.type, c.status])).toEqual([["Check docs", "Explore", "stopped"]]);
    expect(map[1]!.summary).toBeNull();
    expect(flattenAgents(map)).toHaveLength(3);
  });
});

describe("turnTodos", () => {
  const todoWrite = (todos: { content: string; status: string; activeForm?: string }[]) => tool("TodoWrite", { todos });
  const turnOf = (blocks: BlockView[]) => ({ blocks } as TurnView);

  it("is the newest task list the turn wrote", () => {
    const turn = turnOf([
      todoWrite([{ content: "Look", status: "in_progress" }]),
      tool("Bash", {}),
      todoWrite([{ content: "Look", status: "completed" }, { content: "Fix", status: "in_progress", activeForm: "Fixing" }]),
      text("ok"),
    ]);
    expect(turnTodos(turn)?.map((t) => t.status)).toEqual(["completed", "in_progress"]);
    expect(turnActivity(turn)).toBe("Fixing");
  });

  it("is null without a task list, and activity is null with nothing in progress", () => {
    expect(turnTodos(turnOf([tool("Bash", {})]))).toBeNull();
    expect(turnActivity(turnOf([todoWrite([{ content: "Look", status: "completed" }])]))).toBeNull();
  });
});

describe("suggestedReplies", () => {
  const suggest = (replies: unknown) => tool("mcp__renki__suggest_replies", { replies });
  /** `steeredAfter`: the block index each message sent mid-turn landed after. */
  const turnItem = (blocks: BlockView[], status: TurnView["status"] = "done", trigger: TurnView["trigger"] = "prompt", steeredAfter: number[] = []): TimelineItem => ({
    type: "turn",
    turn: {
      turnId: "t1",
      blocks,
      status,
      trigger,
      steeredPrompts: steeredAfter.map((afterBlockIndex) => ({ promptId: "s", deviceId: "d", text: "Yes", afterBlockIndex })),
    } as TurnView,
  });
  const conv = (timeline: TimelineItem[], extra: { sending?: number; queued?: number } = {}) => ({
    timeline,
    sendingPrompts: Array.from({ length: extra.sending ?? 0 }, () => ({}) as never),
    queuedPrompts: Array.from({ length: extra.queued ?? 0 }, () => ({}) as never),
  });

  it("offers the newest finished turn's replies, past notices after it", () => {
    const timeline = [turnItem([text("Deploy?"), suggest(["Yes, deploy", " ", "Not yet"])]), { type: "notice", text: "x", level: "info" } as TimelineItem];
    expect(suggestedReplies(conv(timeline))).toEqual({ turnId: "t1", question: null, replies: ["Yes, deploy", "Not yet"] });
    const withQuestion = [turnItem([tool("mcp__renki__suggest_replies", { question: "Deploy now?", replies: ["Yes"] })])];
    expect(suggestedReplies(conv(withQuestion))?.question).toBe("Deploy now?");
  });

  it("offers nothing once something else is sent, queued, or the turn worked on", () => {
    const asked = turnItem([suggest(["Yes"])]);
    expect(suggestedReplies(conv([asked, { type: "prompt", promptId: "p2", deviceId: "d", text: "Yes" }]))).toBeNull();
    expect(suggestedReplies(conv([asked], { sending: 1 }))).toBeNull();
    expect(suggestedReplies(conv([asked], { queued: 1 }))).toBeNull();
    expect(suggestedReplies(conv([turnItem([suggest(["Yes"]), tool("Bash", {})])]))).toBeNull();
    expect(suggestedReplies(conv([turnItem([suggest(["Yes"])], "error")]))).toBeNull();
  });

  it("looks past turns nobody prompted, running or done, but not past a prompted one", () => {
    const asked = turnItem([suggest(["Yes"])]);
    expect(suggestedReplies(conv([asked, turnItem([tool("Bash", {})], "running", "background_task")]))?.replies).toEqual(["Yes"]);
    expect(suggestedReplies(conv([asked, turnItem([text("done")], "done", "auto")]))?.replies).toEqual(["Yes"]);
    expect(suggestedReplies(conv([asked, turnItem([text("x")], "done", "prompt")]))).toBeNull();
  });

  /** Tapping a reply while a background agent's turn runs sends it into that turn, not as a prompt item. */
  it("offers nothing once a reply was sent while Claude was working", () => {
    const asked = turnItem([suggest(["Yes"])]);
    expect(suggestedReplies(conv([asked, turnItem([tool("Bash", {})], "running", "background_task", [0])]))).toBeNull();
    expect(suggestedReplies(conv([asked, turnItem([], "running", "background_task", [-1])]))).toBeNull();
    // Sent into the asking turn before it asked: the question still stands.
    expect(suggestedReplies(conv([turnItem([text("x"), suggest(["Yes"])], "done", "prompt", [0])]))?.replies).toEqual(["Yes"]);
  });

  it("keeps the call out of the turn's steps", () => {
    const segs = groupTurnBlocks([tool("Bash", {}), text("Deploy?"), suggest(["Yes"])]);
    expect(segs.map((s) => (s.kind === "block" ? s.block.kind : "group"))).toEqual(["tool_use", "text"]);
  });
});

describe("backgroundWorkOf", () => {
  const turnItem = (blocks: BlockView[]): TimelineItem => ({ type: "turn", turn: { turnId: "t1", blocks, status: "done" } as TurnView });

  it("lists background agents and commands with no outcome yet, with what an agent is doing", () => {
    const agent = tool("Agent", { description: "Battery history", run_in_background: true }, {
      toolUseId: "tu_a",
      subagent: { blocks: [tool("Bash", { command: "ls" }), tool("Read", { file_path: "/x/a.ts" })], status: "running" } as never,
    });
    const command = tool("Bash", { command: "npm test -- --watch", description: "Watch the tests", run_in_background: true }, { toolUseId: "tu_c" });
    const finished = tool("Agent", { description: "Done one", run_in_background: true }, { backgroundTask: { status: "completed", summary: "ok" } as never });
    const work = backgroundWorkOf([turnItem([agent, command, finished, tool("Bash", { command: "ls" })])]);
    expect(work.map((w) => [w.kind, w.label, w.steps])).toEqual([
      ["agent", "Battery history", 2],
      ["command", expect.any(String), null],
    ]);
    expect(work[0]!.current).toBe("Read");
    expect(work[0]!.path).toEqual(["tu_a"]);
  });

  it("gives a nested agent's path through its parent", () => {
    const inner = tool("Agent", { description: "Inner", run_in_background: true }, { toolUseId: "tu_in" });
    const outer = tool("Agent", { description: "Outer" }, { toolUseId: "tu_out", subagent: { blocks: [inner], status: "done" } as never });
    expect(backgroundWorkOf([turnItem([outer])]).map((w) => w.path)).toEqual([["tu_out", "tu_in"]]);
  });

  it("leaves out servers left running on purpose", () => {
    const servers = [
      tool("Bash", { command: "cd viewer && python3 -m http.server 3123", description: "Serve the 3D viewer on port 3123", run_in_background: true }),
      tool("Bash", { command: "pnpm dev", run_in_background: true }),
      tool("Bash", { command: "./run.sh", description: "Start the preview server", run_in_background: true }),
    ];
    const build = tool("Bash", { command: "pnpm build", description: "Build the app", run_in_background: true });
    expect(backgroundWorkOf([turnItem([...servers, build])]).map((w) => w.label)).toHaveLength(1);
  });
});
