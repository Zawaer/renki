import { describe, expect, it } from "vitest";
import { ClientMessage } from "../src/ws.js";

describe("ClientMessage: submit_prompt", () => {
  it("validates without model/maxThinkingTokens (every call site before they existed)", () => {
    const msg = { type: "submit_prompt", sessionId: "s1", promptId: "p1", text: "hi" };
    expect(ClientMessage.safeParse(msg).success).toBe(true);
  });

  it("validates with a model override and no thinking budget", () => {
    const msg = { type: "submit_prompt", sessionId: "s1", promptId: "p1", text: "hi", model: "claude-opus-4-8" };
    expect(ClientMessage.safeParse(msg).success).toBe(true);
  });

  it("validates with maxThinkingTokens (including null, for 'off')", () => {
    const withBudget = { type: "submit_prompt", sessionId: "s1", promptId: "p1", text: "hi", maxThinkingTokens: 32_000 };
    const withNull = { type: "submit_prompt", sessionId: "s1", promptId: "p1", text: "hi", maxThinkingTokens: null };
    expect(ClientMessage.safeParse(withBudget).success).toBe(true);
    expect(ClientMessage.safeParse(withNull).success).toBe(true);
  });

  it("rejects a non-integer maxThinkingTokens", () => {
    const msg = { type: "submit_prompt", sessionId: "s1", promptId: "p1", text: "hi", maxThinkingTokens: 1.5 };
    expect(ClientMessage.safeParse(msg).success).toBe(false);
  });
});
