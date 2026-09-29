import { describe, expect, it } from "vitest";
import { modelFullName, modelMenuLabel } from "../src/models.js";

const opus = { value: "opus", displayName: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks" };
const def = { value: "default", displayName: "Default (recommended)", description: "Sonnet 5.5 · Efficient for routine tasks" };
const custom = { value: "claude-fable-5", displayName: "claude-fable-5", description: "" };

describe("modelFullName", () => {
  it("takes the versioned name from the description", () => {
    expect(modelFullName(opus)).toBe("Opus 5.5");
    expect(modelFullName(def)).toBe("Sonnet 5.5");
  });

  it("falls back to displayName without a versioned description", () => {
    expect(modelFullName(custom)).toBe("claude-fable-5");
  });
});

describe("modelMenuLabel", () => {
  it("moves the version into the title for an alias row", () => {
    expect(modelMenuLabel(opus)).toEqual({ title: "Opus 5.5", subtitle: "Best for everyday, complex tasks" });
  });

  it("keeps Default's title and full description", () => {
    expect(modelMenuLabel(def)).toEqual({ title: "Default (recommended)", subtitle: def.description });
  });
});
