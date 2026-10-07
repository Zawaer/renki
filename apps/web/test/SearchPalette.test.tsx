import { RealtimeClient, RestClient } from "@renki/client-core";
import type { SearchHit } from "@renki/protocol";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPalette } from "../src/components/SearchPalette.js";
import { ClientContext } from "../src/lib/client.js";
import { cleanupRoots, render } from "./render.js";

afterEach(cleanupRoots);

// jsdom has no layout, so no scrollIntoView; the arrow keys call it.
Element.prototype.scrollIntoView = () => {};

const hit = (over: Partial<SearchHit>): SearchHit => ({
  sessionId: "s1",
  sessionTitle: "Token stats",
  repoName: "renki",
  repoId: "r1",
  seq: 1,
  ts: Date.now(),
  role: "claude",
  promptId: null,
  turnId: "t1",
  blockIndex: 2,
  snippet: "Cache reads are left out",
  matchStart: 0,
  matchLength: 11,
  ...over,
});

describe("SearchPalette", () => {
  it("searches as you type, groups hits by chat, and opens the picked message", async () => {
    const realtime = new RealtimeClient({ baseUrl: "http://test.invalid", token: "t", deviceId: "d1" });
    const rest = new RestClient({ baseUrl: "http://test.invalid", token: "t" });
    const search = vi.fn(async (q: string) => ({
      query: q,
      hits: [hit({}), hit({ sessionId: "s2", sessionTitle: "Hackathon", seq: 5, role: "you", promptId: "p7", turnId: null, blockIndex: null })],
      truncated: false,
    }));
    rest.search = search;
    const onOpen = vi.fn();
    const config = { baseUrl: "http://test.invalid", token: "t", deviceId: "d1", deviceName: "Test" };
    render(
      <ClientContext.Provider value={{ rest, realtime, config }}>
        <SearchPalette onClose={() => {}} onOpen={onOpen} />
      </ClientContext.Provider>,
    );

    const input = screen.getByLabelText("Search all chats");
    fireEvent.change(input, { target: { value: "cache reads" } });
    await waitFor(() => expect(screen.getByText("Hackathon")).toBeInTheDocument());
    expect(search).toHaveBeenCalledWith("cache reads");
    expect(screen.getByText("Token stats")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("s2", "p:p7", "cache reads");
  });
});
