import { describe, expect, it } from "vitest";
import { classifyRateLimit, summarizeResultError } from "../src/claude/runner.js";

/**
 * classifyRateLimit is the trigger for automatic multi-account rotation: a turn
 * that trips it gets retried once on a switched account. False positives would
 * burn a switch needlessly; false negatives would strand a user on an exhausted
 * account. So the heuristic's boundaries are worth pinning down.
 */
describe("classifyRateLimit", () => {
  it("returns false for empty / missing text", () => {
    expect(classifyRateLimit(null)).toBe(false);
    expect(classifyRateLimit(undefined)).toBe(false);
    expect(classifyRateLimit("")).toBe(false);
  });

  it("matches the known usage/limit phrasings, case-insensitively", () => {
    const hits = [
      "Rate limit exceeded",
      "rate-limited, try again",
      "You hit your usage limit",
      "usage limit reached",
      "limit exceeded for this account",
      "You have exceeded your usage",
      "429 Too Many Requests",
      "too many requests",
    ];
    for (const text of hits) expect(classifyRateLimit(text), text).toBe(true);
  });

  it("does not fire on unrelated errors", () => {
    const misses = [
      "ENOENT: no such file or directory",
      "worktree add failed: branch already exists",
      "Model overloaded, please retry",
      "connection reset by peer",
      "syntax error near unexpected token",
    ];
    for (const text of misses) expect(classifyRateLimit(text), text).toBe(false);
  });
});

/**
 * The SDK's error-shaped result variant carries `errors: string[]`, but
 * account-level failures (e.g. hitting a spend limit) arrive on the
 * "success"-shaped variant instead: subtype "success", is_error true, no
 * `errors` array — only a `result` string with the actual message.
 */
describe("summarizeResultError", () => {
  it("prefers errors[] when present", () => {
    expect(summarizeResultError({ subtype: "error_during_execution", errors: ["boom", "again"] })).toBe("boom; again");
  });

  it("falls back to result text on the success-shaped error variant", () => {
    expect(
      summarizeResultError({ subtype: "success", result: "You've hit your monthly spend limit. /model to switch models." }),
    ).toBe("You've hit your monthly spend limit. /model to switch models.");
  });

  it("falls back to the bare subtype only when neither errors nor result is present", () => {
    expect(summarizeResultError({ subtype: "success" })).toBe("success");
  });

  it("ignores a blank result string", () => {
    expect(summarizeResultError({ subtype: "success", result: "   " })).toBe("success");
  });
});
