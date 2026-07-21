import type { RtkGainResponse } from "@crc/protocol";
import { RealtimeClient, RestClient } from "@crc/client-core";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RtkGainBadge } from "../src/components/RtkGainBadge.js";
import { ClientContext } from "../src/lib/client.js";
import { cleanupRoots, render } from "./render.js";

/**
 * Smoke test for the header's RTK savings badge/dropdown — mirrors
 * AccountsBar.test.tsx. RtkGainBadge silently swallows fetch errors and
 * renders nothing when the feature is off/unavailable, so this pins down
 * both the "visible with real data" and "invisible by default" states.
 */

afterEach(cleanupRoots);

const SAMPLE: RtkGainResponse = {
  enabled: true,
  available: true,
  error: null,
  summary: {
    totalCommands: 3830,
    totalInputTokens: 4_300_000,
    totalOutputTokens: 1_600_000,
    totalSavedTokens: 2_600_000,
    avgSavingsPct: 62,
    totalTimeMs: 3_949_000,
    avgTimeMs: 1024,
  },
  daily: [
    { date: "2026-07-20", commands: 100, inputTokens: 10_000, outputTokens: 5_000, savedTokens: 4_000, savingsPct: 40, totalTimeMs: 1000, avgTimeMs: 10 },
    { date: "2026-07-21", commands: 50, inputTokens: 5_000, outputTokens: 2_000, savedTokens: 1_500, savingsPct: 30, totalTimeMs: 500, avgTimeMs: 10 },
  ],
};

function renderBadge(response: RtkGainResponse) {
  const rest = new RestClient({ baseUrl: "http://test.invalid", token: "t" });
  rest.getRtkGain = async () => response;
  const realtime = new RealtimeClient({ baseUrl: "http://test.invalid", token: "t", deviceId: "d1" });
  const config = { baseUrl: "http://test.invalid", token: "t", deviceId: "d1", deviceName: "Test" };

  return render(
    <ClientContext.Provider value={{ rest, realtime, config }}>
      <RtkGainBadge />
    </ClientContext.Provider>,
  );
}

describe("RtkGainBadge", () => {
  it("shows a badge trigger, and summary + daily rows once opened", async () => {
    renderBadge(SAMPLE);

    const trigger = await screen.findByRole("button", { name: "RTK token savings" });
    // Closed by default — a header badge, not an always-visible panel.
    expect(screen.queryByText("RTK savings (daemon host)")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(screen.getByText("RTK savings (daemon host)")).toBeInTheDocument();
    expect(screen.getByText("3830")).toBeInTheDocument();
    expect(screen.getAllByText("62%").length).toBeGreaterThan(0);
  });

  it("renders nothing when the feature is disabled", async () => {
    renderBadge({ enabled: false, available: false, error: null, summary: null, daily: [] });

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: "RTK token savings" })).not.toBeInTheDocument();
  });

  it("renders nothing when enabled but rtk isn't reachable on the daemon host", async () => {
    renderBadge({ enabled: true, available: false, error: "rtk: command not found", summary: null, daily: [] });

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: "RTK token savings" })).not.toBeInTheDocument();
  });
});
