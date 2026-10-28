import { describe, expect, it } from "vitest";
import { accountsNote } from "../src/sessions/accountsNote.js";

describe("accountsNote", () => {
  it("says nothing with rotation off or a single account", () => {
    expect(accountsNote(0)).toBeNull();
    expect(accountsNote(1)).toBeNull();
  });

  it("tells the session a limit is per account, as Renki context", () => {
    const note = accountsNote(3)!;
    expect(note).toMatch(/^<renki-context>.*<\/renki-context>\n\n$/s);
    expect(note).toContain("one of 3 Claude accounts");
    expect(note).toContain("start the agent again");
  });
});
