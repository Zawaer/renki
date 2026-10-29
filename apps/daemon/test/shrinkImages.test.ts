import type { Attachment } from "@renki/protocol";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { shrinkImages } from "../src/claude/shrinkImages.js";

async function png(width: number, height: number): Promise<Attachment> {
  const buf = await sharp({ create: { width, height, channels: 3, background: "#336699" } }).png().toBuffer();
  return { name: "shot.png", mediaType: "image/png", data: buf.toString("base64") };
}

describe("shrinkImages", () => {
  it("shrinks an image over the edge limit to a JPEG that fits", async () => {
    const { attachments, shrunk } = await shrinkImages([await png(3644, 2370)]);
    expect(shrunk).toBe(1);
    const out = attachments![0]!;
    expect(out).toMatchObject({ name: "shot.jpg", mediaType: "image/jpeg" });
    const meta = await sharp(Buffer.from(out.data, "base64")).metadata();
    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(1301);
  });

  it("leaves small images, other files and unreadable data alone", async () => {
    const small = await png(800, 600);
    const pdf: Attachment = { name: "a.pdf", mediaType: "application/pdf", data: "JVBERi0=" };
    const broken: Attachment = { name: "b.png", mediaType: "image/png", data: "bm90IGFuIGltYWdl" };
    const { attachments, shrunk } = await shrinkImages([small, pdf, broken]);
    expect(shrunk).toBe(0);
    expect(attachments).toEqual([small, pdf, broken]);
  });
});
