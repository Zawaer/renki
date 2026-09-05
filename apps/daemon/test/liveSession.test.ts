import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventPayload } from "@crc/protocol";
import { describe, expect, it, vi } from "vitest";
import { InputChannel, LiveClaudeSession, type LiveSessionOptions } from "../src/claude/liveSession.js";
import type { RunTurnResult } from "../src/claude/runner.js";

/**
 * LiveClaudeSession is the daemon's only route to a `claude` process, so it is
 * driven here by a scripted fake Query: the test pushes SDK messages into the
 * loop and inspects what the runner emitted. No child process is spawned.
 */

type Fake = {
  query: Query;
  /** Deliver one SDK message to the live session's loop. */
  emit: (m: Partial<SDKMessage> & { type: string }) => Promise<void>;
  /** End the message stream (the process exited). */
  end: () => Promise<void>;
  /** Everything the live session wrote to the child's stdin, in order. */
  sent: SDKUserMessage[];
  options: Options;
  interrupt: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setMaxThinkingTokens: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function fakeQueryFactory(): { factory: (p: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query; fake: () => Fake } {
  let fake: Fake | null = null;
  const factory = ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    const inbox: SDKMessage[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const sent: SDKUserMessage[] = [];
    // Drain the live session's input channel like the SDK would, so `sent`
    // reflects what actually reached "stdin".
    void (async () => {
      for await (const m of prompt) sent.push(m);
    })();

    const messages = (async function* () {
      while (true) {
        const next = inbox.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    })();

    const settle = () => new Promise<void>((r) => setTimeout(r, 0));
    const query = Object.assign(messages, {
      interrupt: vi.fn(async () => ({ still_queued: [] })),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      setMaxThinkingTokens: vi.fn(async () => {}),
      getContextUsage: vi.fn(async () => ({ totalTokens: 12_000, maxTokens: 200_000, percentage: 6, isAutoCompactEnabled: true })),
      supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      close: vi.fn(),
    }) as unknown as Query;

    fake = {
      query,
      options,
      sent,
      emit: async (m) => {
        inbox.push({ session_id: "claude-sess-1", ...m } as SDKMessage);
        wake?.();
        await settle();
        await settle();
      },
      end: async () => {
        ended = true;
        wake?.();
        await settle();
        await settle();
      },
      interrupt: (query as unknown as { interrupt: ReturnType<typeof vi.fn> }).interrupt,
      setModel: (query as unknown as { setModel: ReturnType<typeof vi.fn> }).setModel,
      setPermissionMode: (query as unknown as { setPermissionMode: ReturnType<typeof vi.fn> }).setPermissionMode,
      setMaxThinkingTokens: (query as unknown as { setMaxThinkingTokens: ReturnType<typeof vi.fn> }).setMaxThinkingTokens,
      close: (query as unknown as { close: ReturnType<typeof vi.fn> }).close,
    };
    return query;
  };
  return { factory, fake: () => fake! };
}

function makeLive(overrides: Partial<LiveSessionOptions> = {}) {
  const events: EventPayload[] = [];
  const { factory, fake } = fakeQueryFactory();
  const live = new LiveClaudeSession(
    {
      cwd: process.cwd(),
      resumeSessionId: null,
      emit: (p) => events.push(p),
      ...overrides,
    },
    factory,
  );
  return { live, events, fake: fake(), kinds: () => events.map((e) => e.kind) };
}

const allow = async () => ({ decision: "allow" as const, byDeviceId: "d1" });

const okResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 10,
  total_cost_usd: 0.01,
  usage: { input_tokens: 5, output_tokens: 7 },
  result: "done",
} as const;

/** An assistant message with one text block (and optionally one tool_use), from the main agent or a subagent. */
function assistant(text: string, opts: { toolUseId?: string; parent?: string | null } = {}) {
  const content: unknown[] = [{ type: "text", text }];
  if (opts.toolUseId) content.push({ type: "tool_use", id: opts.toolUseId, name: "Agent", input: { prompt: "go" } });
  return { type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: opts.parent ?? null };
}

describe("InputChannel", () => {
  it("yields pushed messages in order and only ends on close()", async () => {
    const ch = new InputChannel();
    const seen: string[] = [];
    const done = (async () => {
      for await (const m of ch) seen.push(String(m.message.content));
    })();
    ch.push({ type: "user", message: { role: "user", content: "a" }, parent_tool_use_id: null });
    ch.push({ type: "user", message: { role: "user", content: "b" }, parent_tool_use_id: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["a", "b"]);
    // Still open: the consumer is parked, not finished.
    let finished = false;
    void done.then(() => (finished = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(finished).toBe(false);
    ch.close();
    await done;
    expect(finished).toBe(true);
  });
});

describe("LiveClaudeSession turns", () => {
  it("sends the prompt with a uuid and resolves runTurn on the matching result, emitting turn_result", async () => {
    const { live, fake, events } = makeLive();
    const pending = live.runTurn({ prompt: "hello", promptId: "p1", resolvePermission: allow, clientType: "web", model: "m1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.message.content).toBe("hello");
    expect(fake.sent[0]!.uuid).toMatch(/[0-9a-f-]{36}/);
    expect(live.busy).toBe(true);

    await fake.emit(assistant("hi there"));
    await fake.emit({ ...okResult, user_message_uuid: fake.sent[0]!.uuid } as never);

    const result = await pending;
    expect(result).toMatchObject({ ok: true, costUsd: 0.01, claudeSessionId: "claude-sess-1", rateLimited: false });
    expect(live.busy).toBe(false);

    const turnResult = events.find((e) => e.kind === "turn_result");
    expect(turnResult).toMatchObject({ promptId: "p1", ok: true, model: "m1", clientType: "web", inputTokens: 5, outputTokens: 7 });
    const block = events.find((e) => e.kind === "assistant_block");
    expect(block).toMatchObject({ blockKind: "text", text: "hi there" });
    expect((block as { turnId: string }).turnId).toBe((turnResult as { turnId: string }).turnId);
  });

  it("keeps the process (and stdin) open across consecutive turns", async () => {
    const { live, fake, events } = makeLive();

    const t1 = live.runTurn({ prompt: "one", promptId: "p1", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    await fake.emit(okResult as never);
    await t1;

    const t2 = live.runTurn({ prompt: "two", promptId: "p2", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    await fake.emit(assistant("second answer"));
    await fake.emit(okResult as never);
    await t2;

    expect(fake.sent.map((m) => m.message.content)).toEqual(["one", "two"]);
    expect(fake.close).not.toHaveBeenCalled();
    const results = events.filter((e) => e.kind === "turn_result") as Array<{ promptId: string; turnId: string }>;
    expect(results.map((r) => r.promptId)).toEqual(["p1", "p2"]);
    expect(results[0]!.turnId).not.toBe(results[1]!.turnId);
  });

  it("applies model / permission mode / thinking changes via control requests only when they differ", async () => {
    const { live, fake } = makeLive({ model: "m1", permissionMode: "default" });

    const t1 = live.runTurn({ prompt: "a", promptId: "p1", resolvePermission: allow, model: "m1", permissionMode: "default" });
    await new Promise((r) => setTimeout(r, 0));
    await fake.emit(okResult as never);
    await t1;
    expect(fake.setModel).not.toHaveBeenCalled();
    expect(fake.setPermissionMode).not.toHaveBeenCalled();
    expect(fake.setMaxThinkingTokens).not.toHaveBeenCalled();

    const t2 = live.runTurn({
      prompt: "b",
      promptId: "p2",
      resolvePermission: allow,
      model: "m2",
      permissionMode: "acceptEdits",
      maxThinkingTokens: 2048,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.setModel).toHaveBeenCalledWith("m2");
    expect(fake.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    expect(fake.setMaxThinkingTokens).toHaveBeenCalledWith(2048);
    // The knobs are applied BEFORE the prompt hits stdin.
    expect(fake.sent).toHaveLength(2);
    await fake.emit(okResult as never);
    await t2;
  });

  it("reports a stopped turn as interrupted, not as an error", async () => {
    const { live, fake, events } = makeLive();
    const t = live.runTurn({ prompt: "long", promptId: "p1", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    await live.interrupt();
    expect(fake.interrupt).toHaveBeenCalledTimes(1);
    await fake.emit({ ...okResult, subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", errors: [] } as never);
    const r = await t;
    expect(r).toMatchObject({ ok: false, interrupted: true, errorMessage: "Stopped by controller." });
    expect(events.find((e) => e.kind === "turn_result")).toMatchObject({ interrupted: true });
  });

  it("flags a rate-limited failure so the manager can rotate accounts and retry", async () => {
    const { live, fake } = makeLive();
    const t = live.runTurn({ prompt: "x", promptId: "p1", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    await fake.emit({ ...assistant("(placeholder)"), error: "rate_limit" } as never);
    await fake.emit({ ...okResult, subtype: "error_during_execution", is_error: true, errors: ["Usage limit reached"] } as never);
    expect(await t).toMatchObject({ ok: false, rateLimited: true, errorMessage: "Usage limit reached" });
  });
});

describe("LiveClaudeSession background agents", () => {
  it("routes a subagent's later output to the turn holding its Task block, even after that turn ended", async () => {
    const { live, fake, events } = makeLive();

    const t1 = live.runTurn({ prompt: "spawn", promptId: "p1", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    await fake.emit(assistant("spawning", { toolUseId: "task-1" }));
    await fake.emit(okResult as never);
    const r1 = await t1;
    expect(r1.ok).toBe(true);
    const turn1 = (events.find((e) => e.kind === "turn_result") as { turnId: string }).turnId;

    // A second, unrelated turn runs while the background agent keeps working.
    const t2 = live.runTurn({ prompt: "other", promptId: "p2", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    await fake.emit(assistant("bg progress", { parent: "task-1" }));
    await fake.emit(assistant("main answer"));
    await fake.emit(okResult as never);
    await t2;
    const turn2 = (events.filter((e) => e.kind === "turn_result")[1] as { turnId: string }).turnId;

    const bgBlock = events.find((e) => e.kind === "assistant_block" && "parentToolUseId" in e && e.parentToolUseId === "task-1") as {
      turnId: string;
    };
    expect(bgBlock.turnId).toBe(turn1);
    const mainBlock = events.find((e) => e.kind === "assistant_block" && (e as { text: string }).text === "main answer") as { turnId: string };
    expect(mainBlock.turnId).toBe(turn2);

    // Completion lands while idle: surfaced as background_task, no turn attached.
    await fake.emit({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", task_type: "agent", description: "x" }] } as never);
    expect(live.backgroundTaskCount).toBe(1);
    await fake.emit({ type: "system", subtype: "task_notification", task_id: "bg1", tool_use_id: "task-1", status: "completed", summary: "all good" } as never);
    expect(live.backgroundTaskCount).toBe(0);
    expect(events.at(-1)).toMatchObject({ kind: "background_task", taskId: "bg1", toolUseId: "task-1", status: "completed" });
    expect(live.busy).toBe(false);
  });

  it("answers a permission request that arrives between turns through the last resolver", async () => {
    const resolver = vi.fn(async () => ({ decision: "deny" as const, byDeviceId: "phone_1" }));
    const { live, fake, events } = makeLive();

    const t1 = live.runTurn({ prompt: "spawn", promptId: "p1", resolvePermission: resolver });
    await new Promise((r) => setTimeout(r, 0));
    await fake.emit(okResult as never);
    await t1;
    const turn1 = (events.find((e) => e.kind === "turn_result") as { turnId: string }).turnId;

    // The SDK calls canUseTool for a background subagent's tool while nothing is in flight.
    const canUseTool = fake.options.canUseTool!;
    const outcome = await canUseTool("Bash", { command: "rm -rf /" }, { signal: new AbortController().signal, toolUseID: "tu-9", requestId: "req-9" } as never);
    expect(outcome).toMatchObject({ behavior: "deny" });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.kind === "permission_request")).toMatchObject({ requestId: "tu-9", turnId: turn1, toolName: "Bash" });
    expect(events.find((e) => e.kind === "permission_resolved")).toMatchObject({ requestId: "tu-9", decision: "deny", byDeviceId: "phone_1" });
  });

  it("treats output nobody prompted as an auto turn: busy for its duration, own turn_result, then idle again", async () => {
    const onAutoTurnStart = vi.fn();
    const onAutoTurnEnd = vi.fn();
    const { live, fake, events } = makeLive({ onAutoTurnStart, onAutoTurnEnd });

    await fake.emit(assistant("reacting to a finished background task"));
    expect(live.busy).toBe(true);
    expect(onAutoTurnStart).toHaveBeenCalledTimes(1);
    const [turnId, promptId] = onAutoTurnStart.mock.calls[0] as [string, string];
    expect(promptId).toBe(`auto_${turnId}`);

    // A prompt submitted mid-auto-turn waits rather than being coalesced into it.
    const t = live.runTurn({ prompt: "next", promptId: "p1", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.sent).toHaveLength(0);

    await fake.emit(okResult as never);
    expect(onAutoTurnEnd).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(events.find((e) => e.kind === "turn_result")).toMatchObject({ turnId, promptId, ok: true });

    // Now the queued prompt goes out and gets its own result.
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.sent).toHaveLength(1);
    await fake.emit(okResult as never);
    expect(await t).toMatchObject({ ok: true });
    expect(events.filter((e) => e.kind === "turn_result")).toHaveLength(2);
  });
});

describe("LiveClaudeSession lifecycle", () => {
  it("close() fails the in-flight turn with a turn_result, terminates the query, and fires onClosed once", async () => {
    const onClosed = vi.fn();
    const { live, fake, events } = makeLive({ onClosed });
    const t = live.runTurn({ prompt: "x", promptId: "p1", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));

    live.close("archived");
    live.close("again");

    const r: RunTurnResult = await t;
    expect(r).toMatchObject({ ok: false, errorMessage: "archived" });
    expect(events.find((e) => e.kind === "turn_result")).toMatchObject({ promptId: "p1", ok: false, errorMessage: "archived" });
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(live.isClosed).toBe(true);
    // A closed session refuses further turns without throwing.
    expect(await live.runTurn({ prompt: "y", promptId: "p2", resolvePermission: allow })).toMatchObject({ ok: false });
  });

  it("a process that exits on its own fails the in-flight turn and reports closed", async () => {
    const onClosed = vi.fn();
    const { live, fake } = makeLive({ onClosed });
    const t = live.runTurn({ prompt: "x", promptId: "p1", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    await fake.end();
    expect(await t).toMatchObject({ ok: false, errorMessage: "process ended" });
    expect(onClosed).toHaveBeenCalledWith("process ended");
    expect(live.isClosed).toBe(true);
  });

  it("passes the resume id, forwardSubagentText and the RTK/permission knobs into the query options", () => {
    const { fake } = makeLive({ resumeSessionId: "old-1", forcePermissionPrompts: true, model: "m1", permissionMode: "plan" });
    expect(fake.options).toMatchObject({ resume: "old-1", settingSources: [], model: "m1", permissionMode: "plan", forwardSubagentText: true, includePartialMessages: true });
  });
});

describe("LiveClaudeSession steering", () => {
  it("pushes a steered prompt into the running turn and reports both prompts on the single turn_result", async () => {
    const { live, fake, events } = makeLive();
    const t = live.runTurn({ prompt: "long task", promptId: "p1", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    await fake.emit(assistant("working", { toolUseId: "tu-1" }));

    live.steer({ prompt: "also do Y in a background agent", promptId: "p2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.sent.map((m) => m.message.content)).toEqual(["long task", "also do Y in a background agent"]);
    // Still one turn: no new turn_started, still busy on the same turn.
    expect(events.filter((e) => e.kind === "turn_started")).toHaveLength(1);
    expect(live.busy).toBe(true);

    await fake.emit(assistant("done both"));
    await fake.emit(okResult as never);
    expect(await t).toMatchObject({ ok: true });
    const results = events.filter((e) => e.kind === "turn_result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ promptId: "p1", promptIds: ["p1", "p2"], ok: true });
    // The steered set is per turn — the next turn starts clean.
    const t2 = live.runTurn({ prompt: "next", promptId: "p3", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    await fake.emit(okResult as never);
    await t2;
    expect(events.filter((e) => e.kind === "turn_result")[1]).toMatchObject({ promptId: "p3", promptIds: ["p3"] });
  });

  it("refuses to steer when nothing is running (the caller runs it as a normal turn instead)", () => {
    const { live } = makeLive();
    expect(() => live.steer({ prompt: "x", promptId: "p1" })).toThrow(/no turn in flight/);
  });

  it("emits turn_started with trigger=prompt for prompted turns and background_task/auto for unprompted ones", async () => {
    const { live, fake, events } = makeLive();
    const t = live.runTurn({ prompt: "spawn", promptId: "p1", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    await fake.emit(okResult as never);
    await t;
    expect(events.find((e) => e.kind === "turn_started")).toMatchObject({ promptId: "p1", trigger: "prompt" });

    // A background task finished, then the CLI speaks unprompted -> background_task.
    await fake.emit({ type: "system", subtype: "task_notification", task_id: "bg1", tool_use_id: "tu-x", status: "completed", summary: "ok" } as never);
    await fake.emit(assistant("the agent finished"));
    await fake.emit(okResult as never);
    const started = events.filter((e) => e.kind === "turn_started") as Array<{ trigger: string; turnId: string }>;
    expect(started[1]!.trigger).toBe("background_task");
    expect(events.filter((e) => e.kind === "turn_result")[1]).toMatchObject({ turnId: started[1]!.turnId });

    // Unprompted again with no task in between -> auto.
    await fake.emit(assistant("hmm, continuing"));
    await fake.emit(okResult as never);
    expect((events.filter((e) => e.kind === "turn_started")[2] as { trigger: string }).trigger).toBe("auto");
  });
});

describe("LiveClaudeSession cost accounting", () => {
  it("reports each turn's own cost, since the SDK's total is cumulative for the process", async () => {
    const { live, fake, events } = makeLive();
    // Three turns whose cumulative totals climb by ~1 cent each.
    for (const [i, total] of [0.184893, 0.1945047, 0.2041338].entries()) {
      const t = live.runTurn({ prompt: `q${i}`, promptId: `p${i}`, resolvePermission: allow });
      await new Promise((r) => setTimeout(r, 0));
      await fake.emit({ ...okResult, total_cost_usd: total } as never);
      await t;
    }
    const costs = (events.filter((e) => e.kind === "turn_result") as Array<{ costUsd: number | null }>).map((e) =>
      Number(e.costUsd!.toFixed(6)),
    );
    expect(costs).toEqual([0.184893, 0.009612, 0.009629]);
  });

  it("counts cached input as input, not as nothing", async () => {
    const { live, fake, events } = makeLive();
    const t = live.runTurn({ prompt: "hi", promptId: "p1", resolvePermission: allow });
    await new Promise((r) => setTimeout(r, 0));
    await fake.emit({
      ...okResult,
      usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 30_709, cache_creation_input_tokens: 58 },
    } as never);
    await t;
    expect(events.find((e) => e.kind === "turn_result")).toMatchObject({ inputTokens: 30_769, outputTokens: 3 });
  });
});
