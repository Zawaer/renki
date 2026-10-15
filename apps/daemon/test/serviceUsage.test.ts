import { type AccountView, createClaudeAccounts } from "claude-accounts-client";
import { describe, expect, it } from "vitest";
import { ServiceUsage, toAccountUsage } from "../src/accounts/service.js";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const H = 3_600_000;

function view(over: Partial<AccountView> = {}): AccountView {
  return {
    email: "a@example.com",
    usageTracked: true,
    usage: {
      limits: [
        { kind: "session", label: "Session usage", model: null, pct: 30, resetsAt: new Date(NOW + 2 * H).toISOString(), severity: "normal" },
        { kind: "weekly_all", label: "All models", model: null, pct: 60, resetsAt: new Date(NOW + 50 * H).toISOString(), severity: "normal" },
        { kind: "weekly_scoped", label: "Fable", model: "Fable", pct: 5, resetsAt: null, severity: "normal" },
      ],
      extra: null,
      fetchedAt: NOW,
    },
    usageError: null,
    blockedUntil: null,
    blockedBy: null,
    lastReport: null,
    recentApps: [],
    ...over,
  };
}

/** A real client whose fetch answers like the service would, recording what it's sent. */
function fakeService(views: AccountView[]) {
  const sent: { method: string; path: string; body: any }[] = [];
  let down = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    sent.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : null });
    if (down) throw new Error("connect ECONNREFUSED");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === "/v1/accounts") return json({ accounts: views, now: NOW });
    if (path === "/v1/report") return json({ ok: true });
    if (path.startsWith("/v1/usage-keys/") && init.method === "DELETE") return json({ ok: true });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  const client = createClaudeAccounts({ url: "http://svc", token: "t", app: "renki", fetch: fetchImpl });
  return { client, sent, setDown: (d: boolean) => (down = d) };
}

describe("toAccountUsage", () => {
  it("maps the service's limits onto Renki's usage shape", () => {
    const u = toAccountUsage(view(), NOW)!;
    expect(u.fiveHour).toEqual({ pct: 30, resetsAt: new Date(NOW + 2 * H).toISOString() });
    expect(u.sevenDay.pct).toBe(60);
    expect(u.limits.map((l) => [l.kind, l.isActive])).toEqual([
      ["session", true],
      ["weekly_all", false],
      ["weekly_scoped", false],
    ]);
  });

  it("shows a block another app reported as that window at 100% until the reset", () => {
    const u = toAccountUsage(view({ blockedBy: "the 5-hour limit", blockedUntil: NOW + H }), NOW)!;
    expect(u.fiveHour).toEqual({ pct: 100, resetsAt: new Date(NOW + H).toISOString() });
    expect(u.sevenDay.pct).toBe(60);
    expect(u.limits.at(-1)).toMatchObject({ kind: "reported", pct: 100, severity: "critical" });
  });

  it("puts a weekly block on the 7-day window", () => {
    const u = toAccountUsage(view({ blockedBy: "the weekly limit", blockedUntil: NOW + 24 * H }), NOW)!;
    expect(u.fiveHour.pct).toBe(30);
    expect(u.sevenDay.pct).toBe(100);
  });

  it("ignores a block that has already lifted", () => {
    const u = toAccountUsage(view({ blockedBy: "the 5-hour limit", blockedUntil: NOW - 1 }), NOW)!;
    expect(u.fiveHour.pct).toBe(30);
  });

  it("still blocks an account the service only knows from reports", () => {
    const u = toAccountUsage(view({ usageTracked: false, usage: null, blockedBy: "the 5-hour limit", blockedUntil: NOW + H }), NOW)!;
    expect(u.fiveHour.pct).toBe(100);
  });

  it("returns nothing for an account with no usage and no block", () => {
    expect(toAccountUsage(view({ usageTracked: false, usage: null }), NOW)).toBeNull();
  });
});

describe("ServiceUsage", () => {
  it("reads usage by email and knows which accounts are tracked", async () => {
    const { client } = fakeService([view(), view({ email: "b@example.com", usageTracked: false, usage: null })]);
    const usage = new ServiceUsage("http://svc", "t", client);
    const byEmail = await usage.usageByEmail();
    expect([...byEmail.keys()]).toEqual(["a@example.com"]);
    expect(usage.configured).toBe(true);
    expect(usage.connectedEmails()).toEqual(["a@example.com"]);
  });

  it("keeps the last reading when the service is down, and says so", async () => {
    const svc = fakeService([view()]);
    const usage = new ServiceUsage("http://svc", "t", svc.client);
    await usage.usageByEmail();
    svc.setDown(true);
    usage.reportLimit("a@example.com", null); // forces the next read past the cache
    const byEmail = await usage.usageByEmail();
    expect(byEmail.get("a@example.com")?.fiveHour.pct).toBe(30);
    expect(usage.errorFor("a@example.com")).toMatch(/didn't answer/);
  });

  it("reports a refused turn to the service, with the reset time", async () => {
    const svc = fakeService([view()]);
    const usage = new ServiceUsage("http://svc", "t", svc.client);
    usage.reportLimit("a@example.com", { resetsAt: NOW + H, type: "five_hour" });
    await new Promise((r) => setTimeout(r, 0));
    const report = svc.sent.find((s) => s.path === "/v1/report");
    expect(report?.body).toMatchObject({ app: "renki", email: "a@example.com", status: "rejected", type: "five_hour", resetsAt: NOW + H });
  });

  it("removes a usage key on the service", async () => {
    const svc = fakeService([view()]);
    const usage = new ServiceUsage("http://svc", "t", svc.client);
    expect(await usage.removeKey("a@example.com")).toBe(true);
    expect(svc.sent.some((s) => s.method === "DELETE" && s.path === "/v1/usage-keys/a%40example.com")).toBe(true);
  });
});
