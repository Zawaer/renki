import { describe, expect, it, vi } from "vitest";
import { RestClient } from "../src/rest.js";

describe("exportSessionText", () => {
  it("asks for Markdown without media, keeps the other choices, and returns the text", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response("# My chat\n\nhéllo — ✓", {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": 'attachment; filename="chat.md"' },
      });
    });
    const rest = new RestClient({ baseUrl: "http://host:4517", token: "t" });
    const text = await rest.exportSessionText("s_1", { tools: false, thinking: true, stats: false });
    vi.unstubAllGlobals();

    expect(text).toBe("# My chat\n\nhéllo — ✓");
    const q = new URL(seen[0]!).searchParams;
    expect(q.get("format")).toBe("markdown");
    expect(q.get("media")).toBe("0");
    expect(q.get("tools")).toBe("0");
    expect(q.get("thinking")).toBe("1");
    expect(q.get("stats")).toBe("0");
  });

  it("passes the daemon's error through", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "not_found", message: "No such session" }), { status: 404 }));
    const rest = new RestClient({ baseUrl: "http://host:4517", token: "t" });
    await expect(rest.exportSessionText("nope")).rejects.toThrow(/No such session/);
    vi.unstubAllGlobals();
  });
});
