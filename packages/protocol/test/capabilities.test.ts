import { describe, expect, it } from "vitest";
import { CapabilitiesResponse } from "../src/capabilities.js";

describe("CapabilitiesResponse", () => {
  it("validates a populated response", () => {
    const res = {
      models: [{ value: "claude-opus-4-8", displayName: "Opus", description: "Most capable" }],
      commands: [{ name: "compact", description: "Summarize the conversation", argumentHint: "" }],
    };
    expect(CapabilitiesResponse.safeParse(res).success).toBe(true);
  });

  it("validates the empty/cold-start shape", () => {
    expect(CapabilitiesResponse.safeParse({ models: [], commands: [] }).success).toBe(true);
  });

  it("rejects a model missing a required field", () => {
    const res = { models: [{ value: "x", displayName: "X" }], commands: [] };
    expect(CapabilitiesResponse.safeParse(res).success).toBe(false);
  });
});
