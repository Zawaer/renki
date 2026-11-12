import { describe, expect, it } from "vitest";
import { describeTool, permissionTitle, toolDisplayName } from "../src/toolViews.js";

describe("tool names in words", () => {
  it("humanizes MCP tool names and leaves built-in ones alone", () => {
    expect(toolDisplayName("mcp__mac__esp_ports")).toBe("Esp ports");
    expect(toolDisplayName("mcp__claude_ai_Gmail__search_threads")).toBe("Search threads");
    expect(toolDisplayName("Read")).toBe("Read");
  });

  it("never shows a raw mcp__ name as a step's label", () => {
    expect(describeTool("mcp__mac__mac_propose_job", { job: "android-release" })).toEqual({ label: "Proposed a Mac build job", meta: "android-release" });
    expect(describeTool("mcp__something__do_thing", {}).label).toBe("Do thing");
  });

  it("titles approvals by what they do", () => {
    expect(permissionTitle("mcp__mac__mac_build", { job: "x", install: true })).toEqual({
      title: "Claude wants to build on your Mac and install it on your phone",
      detail: null,
    });
    expect(permissionTitle("mcp__mac__mac_build", { job: "x" }).title).toBe("Claude wants to build on your Mac");
    expect(permissionTitle("Bash", {})).toEqual({ title: "Claude wants to run a command", detail: null });
    expect(permissionTitle("mcp__x__fetch_page", {})).toEqual({ title: "Claude wants to use a tool", detail: "Fetch page" });
  });
});
