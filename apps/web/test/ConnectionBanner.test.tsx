import { RealtimeClient, RestClient } from "@renki/client-core";
import { screen } from "@testing-library/react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionBanner } from "../src/components/ConnectionBanner.js";
import { ClientContext } from "../src/lib/client.js";
import { cleanupRoots, render } from "./render.js";

afterEach(() => {
  vi.useRealTimers();
  cleanupRoots();
});

describe("ConnectionBanner", () => {
  it("says the host is unreachable after a while down — naming Tailscale for a tailnet host — and goes when it's back", () => {
    vi.useFakeTimers();
    const baseUrl = "http://100.98.104.77:4517";
    const realtime = new RealtimeClient({ baseUrl, token: "t", deviceId: "d1" });
    const rest = new RestClient({ baseUrl, token: "t" });
    const config = { baseUrl, token: "t", deviceId: "d1", deviceName: "Test" };
    render(
      <ClientContext.Provider value={{ rest, realtime, config }}>
        <ConnectionBanner />
      </ClientContext.Provider>,
    );

    flushSync(() => vi.advanceTimersByTime(3_000));
    expect(screen.queryByText("Can't reach your Renki host")).not.toBeInTheDocument(); // a blip, not an outage

    flushSync(() => vi.advanceTimersByTime(6_000));
    expect(screen.getByText("Can't reach your Renki host")).toBeInTheDocument();
    expect(screen.getByText(/Is Tailscale connected/)).toBeInTheDocument();

    flushSync(() => realtime.status.set("open"));
    expect(screen.queryByText("Can't reach your Renki host")).not.toBeInTheDocument();
  });
});
