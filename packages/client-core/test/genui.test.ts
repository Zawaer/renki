import { describe, expect, it } from "vitest";
import { isUiFence, parseUiBlock, uiFallbackMarkdown } from "../src/genui.js";

describe("parseUiBlock", () => {
  it("reads choices, accepting plain strings as options", () => {
    const b = parseUiBlock('{"type":"choices","question":"Which?","options":["A",{"label":"B","detail":"slower","reply":"Go with B"}]}');
    expect(b).toEqual({
      type: "choices",
      question: "Which?",
      options: [
        { label: "A", detail: undefined, reply: undefined },
        { label: "B", detail: "slower", reply: "Go with B" },
      ],
    });
  });

  it("reads a checklist and stats", () => {
    expect(parseUiBlock('{"type":"checklist","items":["one",{"text":"two","done":true}]}')).toMatchObject({
      items: [{ text: "one", done: false }, { text: "two", done: true }],
    });
    expect(parseUiBlock('{"type":"stats","items":[{"label":"Views","value":1200}]}')).toMatchObject({
      items: [{ label: "Views", value: "1200" }],
    });
  });

  it("rejects bad JSON, unknown types and empty lists", () => {
    expect(parseUiBlock('{"type":"choices",')).toBeNull();
    expect(parseUiBlock('{"type":"chart","items":[]}')).toBeNull();
    expect(parseUiBlock('{"type":"choices","options":[]}')).toBeNull();
  });
});

describe("isUiFence", () => {
  it("matches only the renki-ui tag", () => {
    expect(isUiFence("renki-ui")).toBe(true);
    expect(isUiFence(" renki-ui title=x")).toBe(true);
    expect(isUiFence("json")).toBe(false);
    expect(isUiFence(undefined)).toBe(false);
  });
});

describe("uiFallbackMarkdown", () => {
  it("swaps a block for Markdown and keeps the text around it", () => {
    const md = 'Pick one:\n\n```renki-ui\n{"type":"choices","options":["Calm",{"label":"Punchy","detail":"fast cuts"}]}\n```\n\nThanks.';
    expect(uiFallbackMarkdown(md)).toBe("Pick one:\n\n1. Calm\n2. Punchy: fast cuts\n\nThanks.");
  });

  it("renders checklist and stats as lists", () => {
    expect(uiFallbackMarkdown('```renki-ui\n{"type":"checklist","title":"Plan","items":[{"text":"Cut","done":true},"Color"]}\n```')).toBe(
      "**Plan**\n\n- ✓ Cut\n- ○ Color",
    );
    expect(uiFallbackMarkdown('```renki-ui\n{"type":"stats","items":[{"label":"Views","value":"1.2k","note":"+8%"}]}\n```')).toBe(
      "- Views: **1.2k** (+8%)",
    );
  });

  it("keeps an invalid block as code, and hides one still streaming", () => {
    const bad = "```renki-ui\nnot json\n```";
    expect(uiFallbackMarkdown(bad)).toBe(bad);
    expect(uiFallbackMarkdown('Here:\n\n```renki-ui\n{"type":"choi')).toBe("Here:\n");
  });

  it("leaves other code blocks alone", () => {
    const md = "```json\n{\"type\":\"choices\",\"options\":[\"A\"]}\n```";
    expect(uiFallbackMarkdown(md)).toBe(md);
  });
});
