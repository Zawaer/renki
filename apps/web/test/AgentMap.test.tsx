import { agentMapOf, type BlockView, type TimelineItem, type TurnView } from "@renki/client-core";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMapButton, AgentMapDialog } from "../src/components/AgentMap.js";
import { cleanupRoots, render } from "./render.js";

afterEach(cleanupRoots);

const tool = (toolUseId: string, toolName: string, toolInput: unknown, extra: Partial<Extract<BlockView, { kind: "tool_use" }>> = {}): BlockView =>
  ({ kind: "tool_use", toolUseId, toolName, toolInput, result: { ok: true, summary: "" }, ...extra }) as BlockView;

function timeline(turnStatus: TurnView["status"] = "done"): TimelineItem[] {
  const child = tool("tu_child", "Agent", { description: "Read the docs", subagent_type: "Explore" }, {
    agentUsage: { tokens: 1200, toolUses: 2, durationMs: 4000 },
    result: { ok: true, summary: "Docs say **yes**." },
  });
  return [
    {
      type: "turn",
      turn: {
        status: turnStatus,
        blocks: [
          tool("tu_parent", "Agent", { description: "Research the bug", subagent_type: "Explore" }, {
            startedAtMs: 1000,
            agentUsage: { tokens: 57_700, toolUses: 14, durationMs: 355_000 },
            result: { ok: true, summary: "The bug is in **the reducer**.\nagentId: abc" },
            subagent: { subagentType: "Explore", taskDescription: "Research the bug", status: "done", blocks: [child] },
          }),
          tool("tu_cmd", "Bash", { command: "npm run dev", run_in_background: true }),
        ],
      } as TurnView,
    },
  ];
}

describe("AgentMapButton", () => {
  it("counts the session's agents, and opens the map listing them nested", () => {
    render(<AgentMapButton timeline={timeline()} title="Fix the bug" model="claude-opus-5-5" />);
    // The background command has no outcome yet, so it counts as running.
    const button = screen.getByRole("button", { name: "1 running" });
    fireEvent.click(button);

    const dialog = screen.getByRole("dialog", { name: "Agent map" });
    expect(within(dialog).getByText("2 agents · click an agent for details")).toBeInTheDocument();
    expect(within(dialog).getByText("Fix the bug")).toBeInTheDocument();
    expect(within(dialog).getByText("Opus 5.5")).toBeInTheDocument();
    expect(within(dialog).getByText("Research the bug")).toBeInTheDocument();
    expect(within(dialog).getByText("Explore · 5m 55s · 58k tokens")).toBeInTheDocument();
    // The child agent sits inside its parent's list item.
    const parentItem = within(dialog).getByText("Research the bug").closest("li")!;
    expect(within(parentItem).getByText("Read the docs")).toBeInTheDocument();
    expect(within(parentItem).getByText("Explore · 4s · 1.2k tokens")).toBeInTheDocument();
    // Background commands keep their own section.
    expect(within(dialog).getByText("Background commands")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says how many agents there are once nothing runs", () => {
    const items = timeline();
    const turn = (items[0] as Extract<TimelineItem, { type: "turn" }>).turn;
    turn.blocks = turn.blocks.slice(0, 1);
    render(<AgentMapButton timeline={items} title="Fix the bug" model={null} />);
    expect(screen.getByRole("button", { name: "2 agents" })).toBeInTheDocument();
  });

  it("is hidden when the session never started an agent or background command", () => {
    const items: TimelineItem[] = [{ type: "turn", turn: { status: "done", blocks: [tool("tu_ls", "Bash", { command: "ls" })] } as TurnView }];
    render(<AgentMapButton timeline={items} title="x" model={null} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("AgentMapDialog", () => {
  it("expands a card to its tool calls and answer, and points the transcript at it", () => {
    const paths: string[][] = [];
    render(
      <AgentMapDialog
        agents={agentMapOf(timeline())}
        commands={[]}
        title="Fix the bug"
        model={null}
        onClose={() => {}}
        onShowInTranscript={(p) => paths.push(p)}
      />,
    );
    expect(screen.queryByText("the reducer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Read the docs/ }));
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
    expect(screen.getByText("yes").tagName).toBe("STRONG");

    fireEvent.click(screen.getByRole("button", { name: /Show in transcript/ }));
    expect(paths).toEqual([["tu_parent", "tu_child"]]);
  });

  it("ticks a running agent's duration from when it started, and marks it background", () => {
    const agents = agentMapOf([
      {
        type: "turn",
        turn: {
          status: "running",
          blocks: [tool("tu_bg", "Agent", { description: "Watch CI", run_in_background: true }, { startedAtMs: Date.now() - 65_000, result: null })],
        } as TurnView,
      },
    ]);
    render(<AgentMapDialog agents={agents} commands={[]} title="t" model={null} onClose={() => {}} onShowInTranscript={() => {}} />);
    expect(screen.getByText("Agent · 1m 5s")).toBeInTheDocument();
    expect(screen.getByText("background")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument();
  });
});
