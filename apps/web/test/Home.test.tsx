import { RealtimeClient, RestClient } from "@renki/client-core";
import type { Session, StatsResponse } from "@renki/protocol";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Home } from "../src/components/Home.js";
import { ClientContext } from "../src/lib/client.js";
import { cleanupRoots, render } from "./render.js";

afterEach(cleanupRoots);

const todayKey = new Date().toISOString().slice(0, 10);
const day = (key: string, turnCount: number): StatsResponse["daily"][number] => ({
  key,
  costUsd: turnCount * 0.5,
  inputTokens: turnCount * 10_000,
  outputTokens: turnCount * 2_000,
  durationMs: turnCount * 60_000,
  turnCount,
  okCount: turnCount,
});

function renderHome(stats: StatsResponse, sessions: Session[] = []) {
  const realtime = new RealtimeClient({ baseUrl: "http://test.invalid", token: "t", deviceId: "d1" });
  const rest = new RestClient({ baseUrl: "http://test.invalid", token: "t" });
  rest.getStats = async () => stats;
  rest.listSessions = async () => sessions;
  const config = { baseUrl: "http://test.invalid", token: "t", deviceId: "d1", deviceName: "Test" };
  render(
    <ClientContext.Provider value={{ rest, realtime, config }}>
      <Home />
    </ClientContext.Provider>,
  );
}

describe("Home", () => {
  it("shows headline tiles, streaks, a heatmap and the perspective line from the daily buckets", async () => {
    const daily = [day(todayKey, 4)];
    renderHome(
      {
        daily,
        monthly: [],
        byRepo: [],
        byModel: [day("claude-sonnet-5", 4)],
        byClientType: [],
        lifetime: { key: "lifetime", costUsd: 2, inputTokens: 40_000_000, outputTokens: 4_300_000, durationMs: 240_000, turnCount: 4, okCount: 4 },
        firstTurnAt: Date.now(),
      },
      [{ id: "s1", createdAt: Date.now() } as Session, { id: "s2", createdAt: Date.now() } as Session],
    );

    expect(screen.getByText(/What's up next\?/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Replies").nextSibling?.textContent).toBe("4"));
    expect(screen.getByText("Sessions").nextSibling?.textContent).toBe("2");
    expect(screen.getByText("Current streak").nextSibling?.textContent).toBe("1d");
    expect(screen.getByText("Active days").nextSibling?.textContent).toBe("1");
    expect(screen.getByText(/more tokens than The Lord of the Rings/)).toBeInTheDocument();
    expect(screen.getByLabelText("Activity over the last six months")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Models"));
    expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument();
  });

  it("explains itself when there is no activity yet", async () => {
    renderHome({
      daily: [],
      monthly: [],
      byRepo: [],
      byModel: [],
      byClientType: [],
      lifetime: { key: "lifetime", costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, turnCount: 0, okCount: 0 },
      firstTurnAt: null,
    });
    await waitFor(() => expect(screen.getByText("Nothing to show yet")).toBeInTheDocument());
  });
});
