import { describe, expect, it } from "vitest";
import { GatewayApprovals } from "../src/gateway/approvals.js";

const respond = (body: unknown, ok = true) => (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;

describe("GatewayApprovals", () => {
  it("reports changes in what waits for the phone, in ms", async () => {
    const soon = Date.now() / 1000 + 120;
    let body: unknown = { pending: [{ id: "a1", verb: "add-app", summary: "Add x", created: 1, expires: soon }] };
    const g = new GatewayApprovals("http://gw", 1000, (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch);
    const seen: string[][] = [];
    g.onChange((p) => seen.push(p.map((x) => x.id)));
    await g.poll();
    await g.poll(); // unchanged: no second call
    body = { pending: [] };
    await g.poll();
    expect(seen).toEqual([["a1"], []]);
  });

  it("keeps what it knew while the service is unreachable, until each expires", async () => {
    const g = new GatewayApprovals("http://gw", 1000, respond({ pending: [{ id: "a1", verb: "rm-path", summary: "s", created: 1, expires: Date.now() / 1000 + 60 }] }));
    await g.poll();
    (g as unknown as { fetchImpl: typeof fetch }).fetchImpl = respond({}, false);
    await g.poll();
    expect(g.current().map((p) => p.id)).toEqual(["a1"]);
  });
});

describe("GatewayApprovals recent", () => {
  it("passes on what closed lately, in ms, and reports when it changes", async () => {
    let body: unknown = { pending: [], recent: [{ id: "b2", verb: "sh", summary: "Run ls", created: 10, settled: 20, outcome: "expired", by: "timeout", pushed: true }] };
    const g = new GatewayApprovals("http://gw", 1000, (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch);
    let calls = 0;
    g.onChange(() => calls++);
    await g.poll();
    expect(g.recent()).toEqual([{ id: "b2", verb: "sh", summary: "Run ls", created: 10_000, settled: 20_000, outcome: "expired", by: "timeout", pushed: true }]);
    await g.poll();
    expect(calls).toBe(1);
    body = { pending: [], recent: [{ id: "b2", verb: "sh", summary: "Run ls", created: 10, settled: 20, outcome: "bogus" }] };
    await g.poll();
    expect(g.recent()).toEqual([]);
    expect(calls).toBe(2);
  });

  it("stays null against a gateway that doesn't report them", async () => {
    const g = new GatewayApprovals("http://gw", 1000, respond({ pending: [] }));
    await g.poll();
    expect(g.recent()).toBeNull();
  });
});
