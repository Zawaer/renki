import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "@renki/protocol";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { unpackArchives } from "../src/claude/archives.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "renki-archives-"));
  dirs.push(d);
  return d;
}

const zip = (name: string, files: Record<string, Uint8Array>): Attachment => ({
  name,
  mediaType: "application/zip",
  data: Buffer.from(zipSync(files)).toString("base64"),
});

describe("unpackArchives", () => {
  it("passes attachments through untouched when there's no zip", () => {
    const png: Attachment = { name: "a.png", mediaType: "image/png", data: "AAAA" };
    expect(unpackArchives([png], tempDir(), "p1")).toEqual({ attachments: [png], note: "" });
    expect(unpackArchives(undefined, tempDir(), "p1")).toEqual({ attachments: undefined, note: "" });
  });

  it("unpacks a zip and names its files in the note, keeping the other attachments", () => {
    const dir = tempDir();
    const png: Attachment = { name: "a.png", mediaType: "image/png", data: "AAAA" };
    const out = unpackArchives(
      [zip("photos.zip", { "photos/one.txt": strToU8("hello"), "photos/": new Uint8Array(), "__MACOSX/._one.txt": strToU8("x") }), png],
      dir,
      "p1",
    );
    const target = join(dir, "p1", "1-photos");
    expect(out.attachments).toEqual([png]);
    expect(out.note).toContain(`unpacked to ${target}`);
    expect(out.note).toContain("- photos/one.txt (5 B)");
    expect(out.note).not.toContain("__MACOSX");
    expect(readFileSync(join(target, "photos/one.txt"), "utf8")).toBe("hello");
  });

  it("keeps entries from escaping the folder", () => {
    const dir = tempDir();
    const out = unpackArchives([zip("evil.zip", { "../../escaped.txt": strToU8("x"), "ok.txt": strToU8("y") })], dir, "p1");
    expect(out.note).toContain("1 file:");
    expect(existsSync(join(dir, "escaped.txt"))).toBe(false);
    expect(existsSync(join(dir, "..", "escaped.txt"))).toBe(false);
  });

  it("says so when the zip is broken", () => {
    const out = unpackArchives([{ name: "bad.zip", mediaType: "application/zip", data: Buffer.from("not a zip").toString("base64") }], tempDir(), "p1");
    expect(out.attachments).toBeUndefined();
    expect(out.note).toMatch(/bad\.zip, but it couldn't be unpacked/);
  });
});
