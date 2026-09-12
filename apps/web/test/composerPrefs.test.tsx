import { DEFAULT_EFFORT_KEY, DEFAULT_PERMISSION_MODE } from "@renki/client-core";
import { describe, expect, it } from "vitest";
import { clearDraft, loadDeviceDefaults, loadDraft, rememberDeviceDefaults, saveDraft } from "../src/lib/composerPrefs.js";

// Plain unit tests, no rendering — .tsx only to match this project's
// vitest.config.ts include glob (test/**/*.test.tsx).

/**
 * These are the defaults a NEW session is created with — this browser's last
 * pick. The composer's live state is no longer stored here at all: it belongs
 * to the session and is served by the daemon, which is what lets a session
 * started on a phone keep its settings when it's opened here.
 */
describe("device composer defaults", () => {
  it("falls back to the built-in defaults when nothing has been picked yet", () => {
    const d = loadDeviceDefaults();
    expect(d.permissionMode).toBe(DEFAULT_PERMISSION_MODE);
    expect(d.effortKey).toBe(DEFAULT_EFFORT_KEY);
    expect(d.model).toBe("");
  });

  it("round-trips each field, including a custom model id that's in no list", () => {
    rememberDeviceDefaults({ permissionMode: "acceptEdits" });
    rememberDeviceDefaults({ effortKey: "high" });
    rememberDeviceDefaults({ model: "claude-opus-4-8" });
    expect(loadDeviceDefaults()).toEqual({
      permissionMode: "acceptEdits",
      effortKey: "high",
      model: "claude-opus-4-8",
    });
  });

  it("updates only the fields it is given", () => {
    rememberDeviceDefaults({ effortKey: "low", model: "sonnet", permissionMode: "acceptEdits" });
    rememberDeviceDefaults({ model: "opus" });
    const d = loadDeviceDefaults();
    expect(d.model).toBe("opus");
    expect(d.effortKey).toBe("low");
    expect(d.permissionMode).toBe("acceptEdits");
  });

  it("ignores a stored value that is no longer a known mode or effort", () => {
    localStorage.setItem("renki.permissionMode", "bypassPermissions");
    localStorage.setItem("renki.effortKey", "turbo");
    const d = loadDeviceDefaults();
    expect(d.permissionMode).toBe(DEFAULT_PERMISSION_MODE);
    expect(d.effortKey).toBe(DEFAULT_EFFORT_KEY);
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
