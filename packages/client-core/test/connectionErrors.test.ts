import { describe, expect, it } from "vitest";
import { describeConnectionError, describeUnreachable } from "../src/connectionErrors.js";

describe("describeConnectionError", () => {
  it("appends a VPN hint to React Native's generic fetch failure", () => {
    expect(describeConnectionError(new Error("Network request failed"))).toBe(
      "Network request failed Is Tailscale (or your VPN) turned on?",
    );
  });

  it("appends a VPN hint to Chrome/Edge's and Firefox's generic fetch failures, case-insensitively", () => {
    expect(describeConnectionError(new Error("Failed to fetch"))).toContain("Is Tailscale (or your VPN) turned on?");
    expect(describeConnectionError(new Error("NetworkError when attempting to fetch resource."))).toContain(
      "Is Tailscale (or your VPN) turned on?",
    );
    expect(describeConnectionError(new Error("failed TO FETCH"))).toContain("Is Tailscale (or your VPN) turned on?");
  });

  it("leaves a specific, non-generic error message alone", () => {
    expect(describeConnectionError(new Error("Token rejected (401)."))).toBe("Token rejected (401).");
    expect(describeConnectionError(new Error("Daemon responded 500."))).toBe("Daemon responded 500.");
  });

  it("falls back to the given fallback (or the default) for a non-Error thrown value", () => {
    expect(describeConnectionError("boom")).toBe("Could not reach the daemon.");
    expect(describeConnectionError("boom", "Could not reach https://x.")).toBe("Could not reach https://x.");
  });
});

describe("describeUnreachable", () => {
  it("asks about Tailscale for a tailnet address or MagicDNS name", () => {
    expect(describeUnreachable("http://100.98.104.77:4517").viaTailscale).toBe(true);
    expect(describeUnreachable("https://homelab.tail1234.ts.net").body).toMatch(/Tailscale/);
  });
  it("doesn't for anything else", () => {
    expect(describeUnreachable("http://192.168.1.10:4517").viaTailscale).toBe(false);
    expect(describeUnreachable("http://100.20.1.1:4517").viaTailscale).toBe(false);
  });
});
