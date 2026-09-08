import { z } from "zod";

/**
 * Media types Renki hands to the model as a real content block (image or
 * document), mirroring what Claude Code's own chat-box "attach" supports.
 * Anything else the user wants Claude to see, they reference by absolute
 * path in the prompt text instead — Claude reads it itself via the Read
 * tool, same as today, no attachment machinery involved.
 */
export const AttachmentMediaType = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]);
export type AttachmentMediaType = z.infer<typeof AttachmentMediaType>;

/** Per-file cap (decoded bytes) — generous for a screenshot or a short PDF, small enough not to bloat the event log or a single WS message too badly. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Base64 inflates ~4/3; bound the wire string itself as a cheap first check before decoding. */
const MAX_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
export const MAX_ATTACHMENTS_PER_PROMPT = 8;

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
