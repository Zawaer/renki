import { describe, expect, it } from "vitest";
import { classifyAttachment } from "../src/attachments.js";

describe("classifyAttachment", () => {
  it("recognizes each supported image MIME type", () => {
    expect(classifyAttachment({ name: "photo.png", type: "image/png" })).toBe("image/png");
    expect(classifyAttachment({ name: "photo.jpg", type: "image/jpeg" })).toBe("image/jpeg");
    expect(classifyAttachment({ name: "photo.gif", type: "image/gif" })).toBe("image/gif");
    expect(classifyAttachment({ name: "photo.webp", type: "image/webp" })).toBe("image/webp");
  });

  it("is case-insensitive on the MIME type", () => {
    expect(classifyAttachment({ name: "photo.png", type: "IMAGE/PNG" })).toBe("image/png");
  });

  it("recognizes application/pdf", () => {
    expect(classifyAttachment({ name: "doc.pdf", type: "application/pdf" })).toBe("application/pdf");
  });

  it("treats any text/* MIME type as plain text", () => {
    expect(classifyAttachment({ name: "notes.txt", type: "text/plain" })).toBe("text/plain");
    expect(classifyAttachment({ name: "readme.md", type: "text/markdown" })).toBe("text/plain");
    expect(classifyAttachment({ name: "weird.txt", type: "text/x-something-unusual" })).toBe("text/plain");
  });

  it("rejects an unsupported MIME type even with no recognizable extension", () => {
    expect(classifyAttachment({ name: "movie.mp4", type: "video/mp4" })).toBeNull();
    expect(classifyAttachment({ name: "archive.zip", type: "application/zip" })).toBeNull();
  });

  it("falls back to the file extension when the platform reports no MIME type", () => {
    expect(classifyAttachment({ name: "script.py", type: "" })).toBe("text/plain");
    expect(classifyAttachment({ name: "config.yaml", type: "" })).toBe("text/plain");
    expect(classifyAttachment({ name: "notes.MD", type: "" })).toBe("text/plain"); // extension match is case-insensitive
  });

  it("rejects a file with no MIME type and an unrecognized extension", () => {
    expect(classifyAttachment({ name: "photo.heic", type: "" })).toBeNull();
    expect(classifyAttachment({ name: "archive.tar.gz", type: "" })).toBeNull(); // ext is "gz", not in the text-extension set
  });

  it("still applies the extension fallback for a multi-dot filename whose final extension is text-like", () => {
    expect(classifyAttachment({ name: "component.test.ts", type: "" })).toBe("text/plain");
  });

  it("rejects a filename with no dot at all — the whole name is treated as the 'extension' candidate", () => {
    // split(".").pop() on a name with no dot returns the whole name, not "" —
    // only matches TEXT_EXTENSIONS if the filename itself happens to equal one
    // of those extensions, which "Makefile"/"LICENSE" don't.
    expect(classifyAttachment({ name: "Makefile", type: "" })).toBeNull();
    expect(classifyAttachment({ name: "LICENSE", type: "" })).toBeNull();
  });

  it("rejects a filename ending in a bare dot (empty extension)", () => {
    expect(classifyAttachment({ name: "file.", type: "" })).toBeNull();
  });
});
