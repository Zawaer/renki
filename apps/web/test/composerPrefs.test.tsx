import { DEFAULT_EFFORT_KEY, DEFAULT_PERMISSION_MODE } from "@renki/client-core";
import { describe, expect, it } from "vitest";
import {
  loadEffortKey,
  loadModel,
  loadPermissionMode,
  saveEffortKey,
  saveModel,
  savePermissionMode,
  clearDraft,
  loadDraft,
  saveDraft,
} from "../src/lib/composerPrefs.js";

// Plain unit tests, no rendering — .tsx only to match this project's
// vitest.config.ts include glob (test/**/*.test.tsx).

describe("composerPrefs", () => {
  it("defaults permission mode/effort/model when nothing is persisted yet", () => {
    expect(loadPermissionMode()).toBe(DEFAULT_PERMISSION_MODE);
    expect(loadEffortKey()).toBe(DEFAULT_EFFORT_KEY);
    expect(loadModel()).toBe("");
  });

  it("round-trips a saved permission mode", () => {
    savePermissionMode("acceptEdits");
    expect(loadPermissionMode()).toBe("acceptEdits");
  });

  it("round-trips a saved effort key", () => {
    saveEffortKey("high");
    expect(loadEffortKey()).toBe("high");
  });

  it("round-trips a saved model, including a custom (not-in-list) model id", () => {
    saveModel("claude-opus-4-8");
    expect(loadModel()).toBe("claude-opus-4-8");
  });

  it("ignores a corrupted/unknown persisted permission mode and falls back to the default", () => {
    localStorage.setItem("crc.permissionMode", "bypassPermissions");
    expect(loadPermissionMode()).toBe(DEFAULT_PERMISSION_MODE);
  });

  it("ignores a corrupted/unknown persisted effort key and falls back to the default", () => {
    localStorage.setItem("crc.effortKey", "turbo");
    expect(loadEffortKey()).toBe(DEFAULT_EFFORT_KEY);
  });
});

describe("composer drafts", () => {
  const SID = "s_draft";
  const png = { name: "shot.png", mediaType: "image/png" as const, data: "AAAA" };

  it("round-trips text and attachments for a session, and clears on send", () => {
    saveDraft(SID, "half a thought", [png]);
    expect(loadDraft(SID)).toEqual({ text: "half a thought", attachments: [png], attachmentsDropped: false });
    clearDraft(SID);
    expect(loadDraft(SID)).toBeNull();
  });

  it("keeps drafts separate per session", () => {
    saveDraft("s_a", "for A", []);
    saveDraft("s_b", "for B", []);
    expect(loadDraft("s_a")?.text).toBe("for A");
    expect(loadDraft("s_b")?.text).toBe("for B");
  });

  it("treats an empty draft as nothing to keep", () => {
    saveDraft(SID, "   ", []);
    expect(loadDraft(SID)).toBeNull();
  });

  it("keeps the text but drops oversized attachments, and says so", () => {
    const huge = { name: "big.png", mediaType: "image/png" as const, data: "A".repeat(2_000_000) };
    saveDraft(SID, "look at this", [huge]);
    const back = loadDraft(SID);
    expect(back).toMatchObject({ text: "look at this", attachments: [], attachmentsDropped: true });
  });

  it("survives a corrupt stored value instead of throwing", () => {
    localStorage.setItem("crc.draft." + SID, "{not json");
    expect(loadDraft(SID)).toBeNull();
  });
});
