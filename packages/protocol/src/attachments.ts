import { z } from "zod";

/**
 * Media types Renki accepts as attachments. Images, PDFs and text go to the
 * model as a real content block, mirroring what Claude Code's own chat-box
 * "attach" supports; a zip is unpacked on the daemon and Claude is told where
 * its files are. Anything else the user wants Claude to see, they reference
 * by absolute path in the prompt text instead — Claude reads it itself via
 * the Read tool, no attachment machinery involved.
 */
export const AttachmentMediaType = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/zip",
]);
export type AttachmentMediaType = z.infer<typeof AttachmentMediaType>;

/** Per-file cap (decoded bytes) — generous for a screenshot or a short PDF, small enough not to bloat the event log or a single WS message too badly. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Base64 inflates ~4/3; bound the wire string itself as a cheap first check before decoding. */
const MAX_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
export const MAX_ATTACHMENTS_PER_PROMPT = 20;
/**
 * Images are shrunk to fit this many pixels on their longest side (the web
 * composer does it before upload, the daemon catches the rest). The API
 * downscales anything this big anyway, and refuses larger ones outright once a
 * request carries more than 20 images.
 */
export const MAX_IMAGE_EDGE = 2000;
/** An image over this many bytes is re-encoded even if it's small enough in pixels. */
export const SHRINK_IMAGE_ABOVE_BYTES = 1.5 * 1024 * 1024;
/**
 * All of one message's attachments together (decoded bytes). The API caps a
 * whole request at 32 MB of base64, so this leaves room for the rest of it.
 */
export const MAX_PROMPT_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** An attachment's decoded size, from its base64 length. */
export function attachmentBytes(a: { data: string }): number {
  return Math.floor((a.data.length * 3) / 4);
}

/**
 * A file attached to a prompt. Sent inline as base64 over the WS `submit_prompt`
 * message and persisted as part of the resulting `prompt_submitted` event —
 * same as everything else in the log, no separate blob storage. `data` is raw
 * base64 (no `data:` URI prefix).
 */
export const Attachment = z.object({
  name: z.string().min(1).max(255),
  mediaType: AttachmentMediaType,
  data: z.string().min(1).max(MAX_ATTACHMENT_BASE64_LENGTH),
});
export type Attachment = z.infer<typeof Attachment>;

/**
 * An attachment as the event log hands it back. On a replay to a client that
 * asked for `lazyAttachments`, `data` is empty and `ref` is the REST path the
 * bytes are served from, so a long chat's history doesn't carry every
 * screenshot ever sent in it — for a real session that was 8 of its 13 MB.
 * Everywhere else (a live event, an older client) `data` is filled as before.
 */
export const AttachmentView = Attachment.extend({
  data: z.string().max(MAX_ATTACHMENT_BASE64_LENGTH),
  /** e.g. "/sessions/s_1/attachments/42/0" — relative to the daemon's base URL. */
  ref: z.string().optional(),
});
export type AttachmentView = z.infer<typeof AttachmentView>;
