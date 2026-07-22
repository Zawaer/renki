import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UsageReader } from "../src/accounts/usage.js";

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
