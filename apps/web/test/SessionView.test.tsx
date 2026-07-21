import { applyEvents, initialConversation, RealtimeClient, RestClient, THINKING_VERBS } from "@crc/client-core";
import type { SessionEvent } from "@crc/protocol";
import { screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SessionView } from "../src/components/SessionView.js";
import { ClientContext } from "../src/lib/client.js";
import { cleanupRoots, render } from "./render.js";

/**
 * Render smoke test for the actual view that folds ConversationState — the
 * whole point of the shared reducer is that every client (web, mobile,
 * VS Code) renders the SAME state identically, so this needs to exercise the
 * real `applyEvents` output through the real component tree, not a hand-typed
 * fake state object that could drift from what the reducer actually produces.
 */

beforeAll(() => {
  // jsdom doesn't implement scrollTo; SessionView calls it on every render.
  HTMLElement.prototype.scrollTo = () => {};
});

afterEach(cleanupRoots);

let seqCounter = 0;
function ev(sessionId: string, payload: Omit<SessionEvent, "seq" | "sessionId" | "ts">): SessionEvent {
  return { seq: seqCounter++, sessionId, ts: Date.now(), ...payload } as SessionEvent;
}

/**
 * Renders <SessionView> against a real RealtimeClient/RestClient (never
 * connected — no live socket) whose conversation store is pre-seeded by
 * folding real events through the real reducer. A ClientContext.Provider is
 * used directly instead of the exported <ClientProvider> so mounting never
 * tries to open an actual WebSocket.
 */
function renderSession(sessionId: string, events: SessionEvent[], deviceId = "d1") {
  const realtime = new RealtimeClient({ baseUrl: "http://test.invalid", token: "t", deviceId });
  const state = applyEvents(initialConversation(sessionId), events);
  realtime.conversation(sessionId).set(state);
  const rest = new RestClient({ baseUrl: "http://test.invalid", token: "t" });
  const config = { baseUrl: "http://test.invalid", token: "t", deviceId, deviceName: "Test" };

  return render(
    <ClientContext.Provider value={{ rest, realtime, config }}>
      <SessionView sessionId={sessionId} />
    </ClientContext.Provider>,
  );
}

describe("SessionView", () => {
  it("renders a full transcript: prompt, thinking, tool use + result, final text, cost, and a notice", () => {
    const sessionId = "s1";
    const events = [
      ev(sessionId, {
        kind: "session_created",
        repoId: "demo",
        repoName: "demo",
        baseBranch: "main",
        branch: "crc/abc123",
        worktreePath: "/tmp/wt",
      }),
      ev(sessionId, { kind: "status_changed", status: "idle" }),
      ev(sessionId, { kind: "control_changed", controller: "d1", controllerName: "Web" }),
      ev(sessionId, { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "Add a README" }),
      ev(sessionId, { kind: "status_changed", status: "busy" }),
      ev(sessionId, {
        kind: "assistant_block",
        turnId: "t1",
        blockIndex: 0,
        blockKind: "thinking",
        text: "Let me look at the repo first.",
        toolUseId: null,
        toolName: null,
        toolInput: null,
      }),
      ev(sessionId, {
        kind: "assistant_block",
        turnId: "t1",
        blockIndex: 1,
        blockKind: "tool_use",
        text: null,
        toolUseId: "tu1",
        toolName: "Read",
        toolInput: { file_path: "/tmp/wt/README.md" },
      }),
      ev(sessionId, { kind: "tool_result", turnId: "t1", toolUseId: "tu1", ok: true, summary: "1 line" }),
      ev(sessionId, {
        kind: "assistant_block",
        turnId: "t1",
        blockIndex: 2,
        blockKind: "text",
        text: "Done — added a README.",
        toolUseId: null,
        toolName: null,
        toolInput: null,
      }),
      ev(sessionId, {
        kind: "turn_result",
        turnId: "t1",
        promptId: "p1",
        ok: true,
        costUsd: 0.0123,
        durationMs: 4200,
        errorMessage: null,
        inputTokens: 1200,
        outputTokens: 340,
      }),
      ev(sessionId, { kind: "status_changed", status: "idle" }),
      ev(sessionId, { kind: "notice", text: "Switched account — retrying.", level: "info" }),
    ];

    renderSession(sessionId, events);

    expect(screen.getByText("demo")).toBeInTheDocument();
    expect(screen.getByText("You're in control")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("Add a README")).toBeInTheDocument();
    expect(screen.getByText("Let me look at the repo first.")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Done — added a README.")).toBeInTheDocument();
    expect(screen.getByText("$0.0123 · 4200ms · 1.5k tokens")).toBeInTheDocument();
    expect(screen.getByText("Switched account — retrying.")).toBeInTheDocument();
    // Release button, not Take control — this device already holds the lock.
    expect(screen.getByRole("button", { name: "Release" })).toBeInTheDocument();
  });

  it("shows a pending permission request, actionable only by the controller", () => {
    const sessionId = "s2";
    const events = [
      ev(sessionId, {
        kind: "session_created",
        repoId: "demo",
        repoName: "demo",
        baseBranch: "main",
        branch: "crc/xyz",
        worktreePath: "/tmp/wt",
      }),
      ev(sessionId, { kind: "status_changed", status: "busy" }),
      ev(sessionId, { kind: "control_changed", controller: "d1", controllerName: "Web" }),
      ev(sessionId, {
        kind: "permission_request",
        requestId: "r1",
        turnId: "t1",
        toolName: "Bash",
        toolInput: { command: "rm -rf /tmp/scratch" },
      }),
    ];

    // Rendered as the controller: Allow/Deny should be actionable.
    renderSession(sessionId, events, "d1");
    expect(screen.getByText(/Permission requested:/)).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    cleanupRoots();

    // Rendered as a non-controller viewer: no buttons, just the notice.
    renderSession(sessionId, events, "d2");
    expect(screen.getByText("Only the controller can respond.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });

  it("shows the empty state and a Take control button when unlocked", () => {
    const sessionId = "s3";
    const events = [
      ev(sessionId, {
        kind: "session_created",
        repoId: "demo",
        repoName: "demo",
        baseBranch: "main",
        branch: "crc/empty",
        worktreePath: "/tmp/wt",
      }),
      ev(sessionId, { kind: "status_changed", status: "idle" }),
    ];

    renderSession(sessionId, events);

    expect(screen.getByText("No messages yet. Take control and send a prompt.")).toBeInTheDocument();
    expect(screen.getByText("Unlocked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take control" })).toBeInTheDocument();
  });

  it("shows a rotating verb + elapsed seconds while a thinking block is still streaming", () => {
    const sessionId = "s4";
    const events = [
      ev(sessionId, {
        kind: "session_created",
        repoId: "demo",
        repoName: "demo",
        baseBranch: "main",
        branch: "crc/live",
        worktreePath: "/tmp/wt",
      }),
      ev(sessionId, { kind: "status_changed", status: "busy" }),
      ev(sessionId, { kind: "control_changed", controller: "d1", controllerName: "Web" }),
      ev(sessionId, { kind: "prompt_submitted", promptId: "p1", deviceId: "d1", text: "Investigate" }),
      // Explicit past ts (not the ev() helper's Date.now()) so elapsed is a real, non-zero, deterministic-ish value.
      {
        seq: 100,
        sessionId,
        ts: Date.now() - 5000,
        kind: "assistant_delta",
        turnId: "t1",
        blockIndex: 0,
        blockKind: "thinking",
        text: "Hmm, let me think this through carefully before responding",
      } as SessionEvent,
    ];

    renderSession(sessionId, events);

    const verbPattern = new RegExp(`(${THINKING_VERBS.join("|")})…`);
    expect(document.body.textContent).toMatch(verbPattern);
    expect(document.body.textContent).toMatch(/·\s*\d+s/);
    expect(document.body.textContent).toMatch(/·\s*~\d+ tokens/);
  });

  it("shows 'Thought for Xs' once the thinking block is finalized", () => {
    const sessionId = "s5";
    const events = [
      ev(sessionId, {
        kind: "session_created",
        repoId: "demo",
        repoName: "demo",
        baseBranch: "main",
        branch: "crc/done",
        worktreePath: "/tmp/wt",
      }),
      { seq: 100, sessionId, ts: 1000, kind: "assistant_delta", turnId: "t1", blockIndex: 0, blockKind: "thinking", text: "Hmm…" } as SessionEvent,
      {
        seq: 101,
        sessionId,
        ts: 13000,
        kind: "assistant_block",
        turnId: "t1",
        blockIndex: 0,
        blockKind: "thinking",
        text: "Hmm, worked out.",
        toolUseId: null,
        toolName: null,
        toolInput: null,
      } as SessionEvent,
      ev(sessionId, { kind: "status_changed", status: "idle" }),
    ];

    renderSession(sessionId, events);

    expect(screen.getByText("Thought for 12s")).toBeInTheDocument();
  });
});
