import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { createRtkPreToolUseHook } = await import("../src/claude/rtk.js");
const hook = createRtkPreToolUseHook("rtk").hooks[0];

/**
 * rtk's PreToolUse hook only has one job: never let a broken/missing `rtk`
 * binary block a real Bash command. Every failure path here must resolve to
 * `{ continue: true }` rather than throwing or hanging the turn.
 */
function fakeChild(exitCode: number | null, stdoutChunks: string[] = []) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { write: (data: string, cb: (err?: Error) => void) => void; end: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.stdin = Object.assign(new EventEmitter(), {
    write: (_data: string, cb: (err?: Error) => void) => {
      cb();
      queueMicrotask(() => {
        for (const chunk of stdoutChunks) child.stdout.emit("data", Buffer.from(chunk));
        child.emit("close", exitCode);
      });
    },
    end: () => {},
  });
  return child;
}

const baseInput = {
  hook_event_name: "PreToolUse" as const,
  session_id: "s1",
  transcript_path: "/tmp/t",
  cwd: "/tmp",
  tool_name: "Bash",
  tool_input: { command: "git status" },
  tool_use_id: "tu1",
};

describe("rtkPreToolUseHook", () => {
  it("passes through without spawning for non-Bash tools", async () => {
    const controller = new AbortController();
    const result = await hook({ ...baseInput, tool_name: "Read" }, "tu1", { signal: controller.signal });
    expect(result).toEqual({ continue: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("passes through when the rtk binary can't be spawned", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    const controller = new AbortController();
    const result = await hook(baseInput, "tu1", { signal: controller.signal });
    expect(result).toEqual({ continue: true });
  });

  it("passes through on a non-zero exit code", async () => {
    spawnMock.mockImplementationOnce(() => fakeChild(1));
    const controller = new AbortController();
    const result = await hook(baseInput, "tu1", { signal: controller.signal });
    expect(result).toEqual({ continue: true });
  });

  it("passes through on unparseable stdout", async () => {
    spawnMock.mockImplementationOnce(() => fakeChild(0, ["not json"]));
    const controller = new AbortController();
    const result = await hook(baseInput, "tu1", { signal: controller.signal });
    expect(result).toEqual({ continue: true });
  });

  it("returns rtk's rewritten hook output on success", async () => {
    const rewritten = {
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "rtk git status" } },
    };
    spawnMock.mockImplementationOnce(() => fakeChild(0, [JSON.stringify(rewritten)]));
    const controller = new AbortController();
    const result = await hook(baseInput, "tu1", { signal: controller.signal });
    expect(result).toEqual(rewritten);
  });

  it("kills the child process when the turn is aborted", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: EventEmitter & { write: (d: string, cb: (e?: Error) => void) => void; end: () => void };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.stdin = Object.assign(new EventEmitter(), {
      write: () => {}, // never calls back — simulates a hung rtk process
      end: () => {},
    });
    spawnMock.mockImplementationOnce(() => child);

    const controller = new AbortController();
    const pending = hook(baseInput, "tu1", { signal: controller.signal });
    controller.abort();
    expect(child.kill).toHaveBeenCalled();

    // Unstick the promise so the test doesn't hang: aborting doesn't itself
    // resolve runRtkHook's inner promise, only killing the process would (via
    // its own 'close'/'error' event) — simulate that here.
    child.emit("close", null);
    await expect(pending).resolves.toEqual({ continue: true });
  });
});
