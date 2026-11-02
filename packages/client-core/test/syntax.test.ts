import { describe, expect, it } from "vitest";
import {
  splitTokenLines,
  syntaxLanguageForFence,
  syntaxLanguageForPath,
  tokenizeJson,
  tokenizeShell,
  type SyntaxToken,
} from "../src/syntax.js";

/** Round-tripping matters most: colouring must never change the text shown. */
function joined(tokens: SyntaxToken[]): string {
  return tokens.map((t) => t.text).join("");
}
function of(tokens: SyntaxToken[], kind: SyntaxToken["kind"]): string[] {
  return tokens.filter((t) => t.kind === kind).map((t) => t.text);
}

describe("tokenizeShell", () => {
  it("marks the program, its flags and quoted strings", () => {
    const src = `psql -c "DELETE FROM ledger WHERE idem IS NULL" --file cleanup.sql`;
    const t = tokenizeShell(src);
    expect(joined(t)).toBe(src);
    expect(of(t, "command")).toEqual(["psql"]);
    expect(of(t, "argument")).toEqual(["cleanup.sql"]);
    expect(of(t, "flag")).toEqual(["-c", "--file"]);
    expect(of(t, "string")).toEqual([`"DELETE FROM ledger WHERE idem IS NULL"`]);
  });

  it("treats the word after a pipe or semicolon as a new command", () => {
    const t = tokenizeShell("git log --oneline | head -3; echo done");
    expect(of(t, "command")).toEqual(["git", "head", "echo"]);
    expect(of(t, "operator")).toEqual(["|", ";"]);
  });

  it("picks out variables (including inside double quotes), substitutions and comments", () => {
    const src = 'echo "$HOME/${DIR}" $(date) # a note';
    const t = tokenizeShell(src);
    expect(joined(t)).toBe(src);
    expect(of(t, "variable")).toEqual(["$HOME", "${DIR}"]);
    expect(of(t, "comment")).toEqual(["# a note"]);
    expect(of(t, "command")).toContain("date");
  });

  it("tolerates an unterminated quote instead of losing the rest of the line", () => {
    const src = `grep "unfinished`;
    expect(joined(tokenizeShell(src))).toBe(src);
    expect(of(tokenizeShell(src), "string")).toEqual([`"unfinished`]);
  });

  it("ends a comment at the end of its line", () => {
    const src = "# build it\nmake build";
    const t = tokenizeShell(src);
    expect(joined(t)).toBe(src);
    expect(of(t, "comment")).toEqual(["# build it"]);
    expect(of(t, "command")).toEqual(["make"]);
  });

  it("handles && and >> as single operators", () => {
    const t = tokenizeShell("make build && ./run >> out.log");
    expect(of(t, "operator")).toEqual(["&&", ">>"]);
    expect(of(t, "command")).toEqual(["make", "./run"]);
  });
});

describe("tokenizeJson", () => {
  it("separates keys from string values, and marks numbers and literals", () => {
    const src = `{"file_path": "/tmp/a.txt", "limit": 120, "ok": true, "x": null}`;
    const t = tokenizeJson(src);
    expect(joined(t)).toBe(src);
    expect(of(t, "key")).toEqual([`"file_path"`, `"limit"`, `"ok"`, `"x"`]);
    expect(of(t, "string")).toEqual([`"/tmp/a.txt"`]);
    expect(of(t, "number")).toEqual(["120"]);
    expect(of(t, "literal")).toEqual(["true", "null"]);
  });

  it("keeps pretty-printed whitespace and escapes intact", () => {
    const src = `{\n  "msg": "say \\"hi\\"",\n  "n": -12.5\n}`;
    const t = tokenizeJson(src);
    expect(joined(t)).toBe(src);
    expect(of(t, "key")).toEqual([`"msg"`, `"n"`]);
    expect(of(t, "number")).toEqual(["-12.5"]);
  });
});

describe("syntaxLanguageForFence / syntaxLanguageForPath", () => {
  it("knows shell and JSON by fence word, ignoring case and anything after it", () => {
    expect(syntaxLanguageForFence("bash")).toBe("shell");
    expect(syntaxLanguageForFence("Shell title=setup")).toBe("shell");
    expect(syntaxLanguageForFence("jsonc")).toBe("json");
    expect(syntaxLanguageForFence("ts")).toBeNull();
    expect(syntaxLanguageForFence("")).toBeNull();
    expect(syntaxLanguageForFence(undefined)).toBeNull();
  });

  it("knows them by file extension and shell dotfiles", () => {
    expect(syntaxLanguageForPath("scripts/deploy.sh")).toBe("shell");
    expect(syntaxLanguageForPath("apps/web/package.JSON")).toBe("json");
    expect(syntaxLanguageForPath("/home/me/.zshrc")).toBe("shell");
    expect(syntaxLanguageForPath("src/index.ts")).toBeNull();
    expect(syntaxLanguageForPath(".json")).toBeNull();
    expect(syntaxLanguageForPath("Makefile")).toBeNull();
  });
});

describe("splitTokenLines", () => {
  it("splits tokens at newlines, one array per source line", () => {
    const src = `{\n  "a": "x",\n\n  "b": 1\n}`;
    const lines = splitTokenLines(tokenizeJson(src));
    expect(lines.map(joined)).toEqual(src.split("\n"));
    expect(of(lines[1]!, "key")).toEqual([`"a"`]);
    expect(lines[2]).toEqual([]);
  });

  it("keeps a trailing empty line like split does", () => {
    expect(splitTokenLines(tokenizeShell("ls\n")).length).toBe(2);
    expect(splitTokenLines([]).length).toBe(1);
  });
});
