import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "../src/lib/plainText.js";

describe("markdownToPlainText", () => {
  it("drops quote markers and emphasis but keeps list numbers", () => {
    const md = `Here it is:

> Thanks a **lot**! A few follow-ups:
>
> 1. Are the RTX PRO 6000s the \`Workstation\` Edition?
> 2. Where does the server sit?`;
    expect(markdownToPlainText(md)).toBe(
      "Here it is:\n\nThanks a lot! A few follow-ups:\n\n1. Are the RTX PRO 6000s the Workstation Edition?\n2. Where does the server sit?",
    );
  });

  it("keeps a link's URL, nests bullets, and flattens a table to one line per row", () => {
    const md = `See [the invoice](https://x.y/z) or https://a.b

- a
  - nested
- b

| | Friend | Pihi |
|---|---|---|
| Total | €10,240 | €9,900 |`;
    expect(markdownToPlainText(md)).toBe(
      "See the invoice (https://x.y/z) or https://a.b\n\n• a\n  • nested\n• b\n\n · Friend · Pihi\nTotal · €10,240 · €9,900",
    );
  });
});
