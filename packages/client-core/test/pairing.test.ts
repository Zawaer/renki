import { describe, expect, it } from "vitest";
import { decodePairing, encodePairing, isLikelyLoopbackUrl } from "../src/pairing.js";

describe("encodePairing/decodePairing round trip", () => {
  it("decodes exactly what was encoded", () => {
    const payload = { baseUrl: "https://homelab.tailnet.ts.net", token: "sk-abc123" };
    expect(decodePairing(encodePairing(payload))).toEqual(payload);
  });
});

describe("decodePairing", () => {
  it("rejects malformed JSON", () => {
    expect(decodePairing("not json at all")).toBeNull();
    expect(decodePairing("")).toBeNull();
  });

  it("rejects valid JSON that isn't an object", () => {
    expect(decodePairing("42")).toBeNull();
    expect(decodePairing('"a string"')).toBeNull();
    expect(decodePairing("null")).toBeNull();
  });

  it("rejects an unrelated JSON object (e.g. some other app's QR code)", () => {
    expect(decodePairing(JSON.stringify({ someOtherApp: true, data: "xyz" }))).toBeNull();
  });

  it("rejects a payload with the wrong magic version", () => {
    expect(decodePairing(JSON.stringify({ crcPairing: 2, baseUrl: "https://x", token: "t" }))).toBeNull();
    expect(decodePairing(JSON.stringify({ crcPairing: "1", baseUrl: "https://x", token: "t" }))).toBeNull();
  });

  it("rejects a payload missing baseUrl or token", () => {
    expect(decodePairing(JSON.stringify({ crcPairing: 1, token: "t" }))).toBeNull();
    expect(decodePairing(JSON.stringify({ crcPairing: 1, baseUrl: "https://x" }))).toBeNull();
  });

  it("rejects a payload with non-string or empty baseUrl/token", () => {
    expect(decodePairing(JSON.stringify({ crcPairing: 1, baseUrl: 123, token: "t" }))).toBeNull();
    expect(decodePairing(JSON.stringify({ crcPairing: 1, baseUrl: "", token: "t" }))).toBeNull();
    expect(decodePairing(JSON.stringify({ crcPairing: 1, baseUrl: "https://x", token: "" }))).toBeNull();
  });

  it("ignores extra fields on an otherwise-valid payload", () => {
    const raw = JSON.stringify({ crcPairing: 1, baseUrl: "https://x", token: "t", extra: "ignored" });
    expect(decodePairing(raw)).toEqual({ baseUrl: "https://x", token: "t" });
  });
});

describe("isLikelyLoopbackUrl", () => {
  it("flags common loopback hostnames regardless of scheme/port", () => {
    expect(isLikelyLoopbackUrl("http://localhost:4517")).toBe(true);
    expect(isLikelyLoopbackUrl("https://127.0.0.1")).toBe(true);
    expect(isLikelyLoopbackUrl("http://[::1]:4517")).toBe(true);
    expect(isLikelyLoopbackUrl("http://0.0.0.0:4517")).toBe(true);
  });

  it("is case-insensitive on the hostname", () => {
    expect(isLikelyLoopbackUrl("http://LOCALHOST:4517")).toBe(true);
  });

  it("does not flag a real reachable hostname/IP", () => {
    expect(isLikelyLoopbackUrl("https://homelab.tailnet.ts.net")).toBe(false);
    expect(isLikelyLoopbackUrl("http://192.168.1.50:4517")).toBe(false);
  });

  it("returns false (not throws) for an unparseable URL", () => {
    expect(isLikelyLoopbackUrl("not a url")).toBe(false);
    expect(isLikelyLoopbackUrl("")).toBe(false);
  });
});
