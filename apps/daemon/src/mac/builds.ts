import { randomBytes } from "node:crypto";
import type { EventPayload } from "@renki/protocol";
import type { MacProgress, MacResult } from "./bridge.js";

/**
 * Build jobs on the Mac that are running in the background (see mac/tools.ts
 * `mac_build`). A build takes minutes; a tool call that blocked for all of
 * them would leave Claude unable to do anything else, or even read a message
 * sent meanwhile (the CLI only takes those in between tool calls). So the call
 * returns as soon as the job starts, and this registry carries it from there:
 *
 * - its progress goes into the session's log as `mac_build` events, so every
 *   client can show where it has got to;
 * - when it ends, its result goes to Claude as a message (`finished`), which
 *   the session manager delivers into the running turn or starts a turn with.
 *
 * Daemon-wide, not per `claude` process: a build outlives the turn that
 * started it, and the session's process may be replaced while it runs.
 */

export type MacBuildSink = {
  /** Append one event to the session's log. */
  emit: (sessionId: string, payload: EventPayload) => void;
  /** The build ended: tell Claude in this session. */
  finished: (sessionId: string, message: string) => void;
};

export type MacBuild = {
  id: string;
  sessionId: string;
  toolUseId: string | null;
  job: string;
  state: "running" | "succeeded" | "failed";
  phase: string;
  detail: string | null;
  startedAt: number;
  endedAt: number | null;
  /** What the Mac reported in the end (exit code, artifacts, log tail). */
  result: MacResult | null;
};

/** A log line changes many times a second; one in this long reaches the log. Phase changes always do. */
const DETAIL_EVERY_MS = 10_000;
/** Finished builds are kept this long for mac_build_status. */
const KEEP_FINISHED_MS = 2 * 60 * 60_000;

export class MacBuilds {
  private readonly builds = new Map<string, MacBuild & { emittedAt: number }>();
  private sink: MacBuildSink | null = null;

  setSink(sink: MacBuildSink): void {
    this.sink = sink;
  }

  /**
   * Start a build. `run` does the work and reports progress; it must not
   * reject (MacBridge.call never does).
   */
  start(opts: { sessionId: string; toolUseId: string | null; job: string; run: (onProgress: (p: MacProgress) => void) => Promise<MacResult> }): MacBuild {
    this.sweep();
    const b: MacBuild & { emittedAt: number } = {
      id: `b_${randomBytes(4).toString("hex")}`,
      sessionId: opts.sessionId,
      toolUseId: opts.toolUseId,
      job: opts.job,
      state: "running",
      phase: "Starting",
      detail: null,
      startedAt: Date.now(),
      endedAt: null,
      result: null,
      emittedAt: 0,
    };
    this.builds.set(b.id, b);
    this.report(b);

    void opts
      .run((p) => {
        if (b.state !== "running") return;
        const phaseChanged = p.phase !== b.phase;
        b.phase = p.phase;
        b.detail = p.detail ?? (phaseChanged ? null : b.detail);
        if (phaseChanged || Date.now() - b.emittedAt >= DETAIL_EVERY_MS) this.report(b);
      })
      .catch((err): MacResult => ({ ok: false, text: `The build failed: ${err instanceof Error ? err.message : String(err)}` }))
      .then((r) => {
        Object.assign(b, {
          state: r.ok ? "succeeded" : "failed",
          phase: r.ok ? "Succeeded" : "Failed",
          detail: firstLine(r.text),
          endedAt: Date.now(),
          result: r,
        });
        this.report(b);
        this.sink?.finished(b.sessionId, finishedMessage(b, r));
      });
    return this.view(b);
  }

  /** Builds this session started that haven't ended. */
  running(sessionId: string): MacBuild[] {
    return this.forSession(sessionId).filter((b) => b.state === "running");
  }

  /** This session's builds, newest first. */
  forSession(sessionId: string): MacBuild[] {
    return [...this.builds.values()].filter((b) => b.sessionId === sessionId).reverse().map((b) => this.view(b));
  }

  private report(b: MacBuild & { emittedAt: number }): void {
    b.emittedAt = Date.now();
    this.sink?.emit(b.sessionId, {
      kind: "mac_build",
      buildId: b.id,
      toolUseId: b.toolUseId,
      job: b.job,
      state: b.state,
      phase: b.phase,
      detail: b.detail,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
    });
  }

  private view(b: MacBuild & { emittedAt: number }): MacBuild {
    const { emittedAt: _, ...rest } = b;
    return { ...rest };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, b] of this.builds) if (b.endedAt !== null && now - b.endedAt > KEEP_FINISHED_MS) this.builds.delete(id);
  }
}

function firstLine(text: string): string | null {
  const line = text.split("\n").find((l) => l.trim())?.trim();
  return line ? line.slice(0, 300) : null;
}

/** What Claude is told when a build ends: the same report the tool used to return, framed as a notification. */
export function finishedMessage(b: Pick<MacBuild, "id" | "job">, r: MacResult): string {
  return [
    `<mac-build-finished build="${b.id}" job="${b.job}" outcome="${r.ok ? "succeeded" : "failed"}">`,
    r.text || (r.ok ? "Done." : "Failed."),
    "</mac-build-finished>",
    "(This is the result of a mac_build you started earlier, not a message from the user.)",
  ].join("\n");
}

export function describeBuild(b: MacBuild, now = Date.now()): string {
  const secs = Math.round(((b.endedAt ?? now) - b.startedAt) / 1000);
  const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  return b.state === "running"
    ? `${b.id} (${b.job}): running for ${took}. ${b.phase}${b.detail ? `: ${b.detail}` : ""}`
    : `${b.id} (${b.job}): ${b.state} after ${took}.`;
}
