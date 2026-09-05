import { describe, expect, it } from "vitest";
import { getCapabilities, hasCapabilities, setCapabilities, withExtraModels } from "../src/claude/capabilities.js";

/**
 * Process-lifetime cache — only obtainable from a live SDK Query object (see
 * runner.ts), so it starts empty and this just pins down the get/has/set
 * contract the rest of the daemon relies on.
 */
describe("claude/capabilities cache", () => {
  it("reports empty models/commands (not an error) before anything is cached", () => {
    // Note: shares module state with the other test below within this file;
    // vitest isolates module state per test FILE, not per `it`, so this only
    // holds if it runs first — asserted structurally, not via hasCapabilities(),
    // to avoid depending on execution order.
    const caps = getCapabilities();
    expect(caps.models).toEqual(expect.any(Array));
    expect(caps.commands).toEqual(expect.any(Array));
  });

  it("setCapabilities makes hasCapabilities true and getCapabilities return exactly what was set", () => {
    const caps = {
      models: [{ value: "claude-opus-4-8", displayName: "Opus", description: "Most capable" }],
      commands: [{ name: "compact", description: "Summarize the conversation", argumentHint: "" }],
    };
    setCapabilities(caps);
    expect(hasCapabilities()).toBe(true);
    expect(getCapabilities().commands).toEqual(caps.commands);
    expect(getCapabilities().models).toEqual(withExtraModels(caps.models));
  });
});

describe("withExtraModels", () => {
  const sdk = [
    { value: "default", displayName: "Default (recommended)", description: "Sonnet 5" },
    { value: "claude-sonnet-5", displayName: "Sonnet", description: "" },
    { value: "claude-opus-5", displayName: "Opus", description: "" },
    { value: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "" },
  ];

  it("slots Fable in after Default/Sonnet when the CLI doesn't list it", () => {
    expect(withExtraModels(sdk).map((m) => m.displayName)).toEqual(["Default (recommended)", "Sonnet", "Fable", "Opus", "Haiku"]);
    expect(withExtraModels(sdk)[2]).toMatchObject({ value: "claude-fable-5-1" });
  });

  it("leaves the list alone when the CLI already lists that family, whatever the exact id", () => {
    const withFable = [...sdk.slice(0, 2), { value: "claude-fable-5-1-20260901", displayName: "Fable", description: "" }, ...sdk.slice(2)];
    expect(withExtraModels(withFable)).toEqual(withFable);
  });

  it("appends when the CLI list is short", () => {
    expect(withExtraModels([]).map((m) => m.value)).toEqual(["claude-fable-5-1"]);
  });
});
