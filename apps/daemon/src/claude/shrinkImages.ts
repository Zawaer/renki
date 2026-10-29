import { MAX_IMAGE_EDGE, SHRINK_IMAGE_ABOVE_BYTES, type Attachment } from "@renki/protocol";
import sharp from "sharp";
import { logger } from "../logger.js";

const SHRINKABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Shrinks a prompt's big images to fit MAX_IMAGE_EDGE, as a JPEG. The web
 * composer already does this before upload; this catches the clients that
 * can't (the phone app's picker sends photos as taken). GIFs are left alone,
 * they may be animated. A shrink that comes out no smaller is dropped, and an
 * image sharp can't read goes through unchanged for the API to judge.
 */
export async function shrinkImages(attachments: Attachment[] | undefined): Promise<{ attachments?: Attachment[]; shrunk: number }> {
  if (!attachments?.length) return { attachments, shrunk: 0 };
  let shrunk = 0;
  const out = await Promise.all(
    attachments.map(async (a) => {
      if (!SHRINKABLE.has(a.mediaType)) return a;
      try {
        const input = Buffer.from(a.data, "base64");
        const { width = 0, height = 0 } = await sharp(input).metadata();
        if (Math.max(width, height) <= MAX_IMAGE_EDGE && input.length <= SHRINK_IMAGE_ABOVE_BYTES) return a;
        const output = await sharp(input)
          .rotate() // apply EXIF orientation before it's stripped
          .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 85 })
          .toBuffer();
        if (output.length >= input.length && Math.max(width, height) <= MAX_IMAGE_EDGE) return a;
        shrunk++;
        return { name: a.name.replace(/\.[^.]*$/, "") + ".jpg", mediaType: "image/jpeg" as const, data: output.toString("base64") };
      } catch (err) {
        logger.warn("image shrink failed", { name: a.name, err: String(err) });
        return a;
      }
    }),
  );
  return { attachments: out, shrunk };
}
