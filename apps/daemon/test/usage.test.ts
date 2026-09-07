import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseExtra, parseLimits, UsageReader } from "../src/accounts/usage.js";

/**
 * UsageReader talks to claude.ai over `Impit` (a browser-fingerprint HTTP
 * client), which isn't mockable via normal fetch interception. These tests
 * swap the private `http` field for a fake with the same `fetch(url, init)`
 * shape, keyed by path so each test can script exactly what claude.ai "returns".
 */
function withConfig(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "crc-usage-test-"));
  const path = join(dir, "usage-accounts.json");
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

function fakeHttp(routes: Record<string, unknown>) {
  return {
    fetch: vi.fn(async (url: string) => {
      const path = new URL(url).pathname + new URL(url).search;
      const body = routes[path];
      if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    }),
  };
}

describe("orgId auto-resolve", () => {
  it("resolves and persists orgId when the key sees exactly one org", async () => {
    const configPath = withConfig([{ email: "a@example.com", sessionKey: "sk-ant-sid01-x" }]);
    const reader = new UsageReader(configPath);
    (reader as any).http = fakeHttp({
      "/api/organizations": [{ uuid: "org-1", name: "Only Org" }],
      "/api/organizations/org-1/usage": { limits: [{ group: "session", percent: 42, resets_at: null }] },
    });

    const usage = await reader.usageByEmail();
    expect(usage.get("a@example.com")?.fiveHour.pct).toBe(42);

    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    expect(persisted[0].orgId).toBe("org-1");
  });

  it("leaves orgId unresolved (usage unavailable) when the key sees multiple orgs", async () => {
    const configPath = withConfig([{ email: "b@example.com", sessionKey: "sk-ant-sid01-y" }]);
    const reader = new UsageReader(configPath);
    (reader as any).http = fakeHttp({
      "/api/organizations": [{ uuid: "org-1" }, { uuid: "org-2" }],
    });

    const usage = await reader.usageByEmail();
    expect(usage.has("b@example.com")).toBe(false);

    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    expect(persisted[0].orgId).toBeUndefined();
  });

  it("leaves orgId unresolved when the key sees zero orgs", async () => {
    const configPath = withConfig([{ email: "c@example.com", sessionKey: "sk-ant-sid01-z" }]);
    const reader = new UsageReader(configPath);
    (reader as any).http = fakeHttp({ "/api/organizations": [] });

    const usage = await reader.usageByEmail();
    expect(usage.has("c@example.com")).toBe(false);
  });

  it("skips resolution entirely when an orgId is already on file", async () => {
    const configPath = withConfig([{ email: "d@example.com", sessionKey: "sk-ant-sid01-w", orgId: "org-9" }]);
    const reader = new UsageReader(configPath);
    const http = fakeHttp({
      "/api/organizations/org-9/usage": { limits: [{ group: "session", percent: 10, resets_at: null }] },
    });
    (reader as any).http = http;

    const usage = await reader.usageByEmail();
    expect(usage.get("d@example.com")?.fiveHour.pct).toBe(10);
    // The org-list endpoint was never hit — no auto-resolve attempt needed.
    expect(http.fetch).not.toHaveBeenCalledWith("https://claude.ai/api/organizations", expect.anything());
    expect(http.fetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * The real payload from claude.ai (September 2026): three concurrent windows —
 * the 5-hour session, a weekly cap across all models, and a separate weekly
 * cap for one premium model. CRC modelled only the first two, so a Fable or
 * Opus allowance running out was invisible.
 */
const REAL_LIMITS = {
  limits: [
    { kind: "session", group: "session", percent: 99, severity: "critical", resets_at: "2026-09-07T12:30:00.043407+00:00", scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 21, severity: "normal", resets_at: "2026-09-08T15:00:00.043431+00:00", scope: null, is_active: false },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 32,
      severity: "normal",
      resets_at: "2026-09-08T15:00:00.043669+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
};

describe("parseLimits", () => {
  it("keeps all three windows, labelling the scoped one by its model", () => {
    const limits = parseLimits(REAL_LIMITS);
    expect(limits.map((l) => [l.kind, l.label, l.pct])).toEqual([
      ["session", "Session usage", 99],
      ["weekly_all", "All models", 21],
      ["weekly_scoped", "Fable", 32],
    ]);
    expect(limits[2]!.model).toBe("Fable");
    expect(limits[0]!.model).toBeNull();
  });

  it("carries severity and which window is currently being consumed", () => {
    const limits = parseLimits(REAL_LIMITS);
    expect(limits[0]).toMatchObject({ severity: "critical", isActive: true });
    expect(limits[1]).toMatchObject({ severity: "normal", isActive: false });
  });

  it("keeps a window kind it has never seen rather than dropping it", () => {
    const limits = parseLimits({ limits: [{ kind: "monthly_experiment", percent: 7 }] });
    expect(limits).toEqual([
      { kind: "monthly_experiment", label: "monthly_experiment", model: null, pct: 7, resetsAt: null, severity: "normal", isActive: false },
    ]);
  });

  it("is empty for an older response with no limits array, and skips junk entries", () => {
    expect(parseLimits({ five_hour: { utilization: 12 } })).toEqual([]);
    expect(parseLimits({ limits: [null, { percent: "nope" }, undefined] })).toEqual([]);
  });
});

describe("parseExtra", () => {
  // Both of the user's orgs report exactly this: credits exist as a concept,
  // but are off. A meter reading "0.00 / 0.00" there would be pure noise.
  it("is null when the plan has no credits enabled", () => {
    expect(
      parseExtra({
        spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 }, limit: null, percent: 0, enabled: false, disabled_reason: "out_of_credits" },
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, credits_ever_enabled: true },
      }),
    ).toBeNull();
    expect(parseExtra({})).toBeNull();
    expect(parseExtra(null)).toBeNull();
  });

  it("reads the newer spend shape once enabled, in whole currency units", () => {
    expect(
      parseExtra({
        spend: {
          used: { amount_minor: 4250, currency: "USD", exponent: 2 },
          limit: { amount_minor: 30_000, currency: "USD", exponent: 2 },
          percent: 14.2,
          severity: "warning",
          enabled: true,
        },
      }),
    ).toEqual({ pct: 14.2, usedDollars: 42.5, limitDollars: 300, currency: "USD", severity: "warning" });
  });

  it("falls back to the older extra_usage shape, scaled by its decimal places", () => {
    expect(
      parseExtra({
        extra_usage: { is_enabled: true, utilization: 79, used_credits: 3953, monthly_limit: 5000, currency: "EUR", decimal_places: 2 },
      }),
    ).toEqual({ pct: 79, usedDollars: 39.53, limitDollars: 50, currency: "EUR", severity: "normal" });
  });

  it("prefers spend over extra_usage when both are present", () => {
    const both = parseExtra({
      spend: { used: { amount_minor: 100, exponent: 2 }, limit: { amount_minor: 1000, exponent: 2 }, percent: 10, enabled: true },
      extra_usage: { is_enabled: true, utilization: 99, used_credits: 9900, monthly_limit: 10_000, decimal_places: 2 },
    });
    expect(both).toMatchObject({ pct: 10, limitDollars: 10 });
  });
});
