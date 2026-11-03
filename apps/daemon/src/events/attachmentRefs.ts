import type { AttachmentView, SessionEvent } from "@renki/protocol";

/**
 * A replayed prompt's attachments as references to fetch rather than their
 * bytes (see AttachmentView). Live events keep their data: they're one prompt,
 * and the sender wants to see it at once.
 */
export function withAttachmentRefs(e: SessionEvent): SessionEvent {
  const refs = (list: AttachmentView[]) =>
    list.map((a, i) => ({
      name: a.name,
      mediaType: a.mediaType,
      data: "",
      ref: `/sessions/${encodeURIComponent(e.sessionId)}/attachments/${e.seq}/${i}`,
    }));
  if (e.kind === "prompt_submitted" && e.attachments?.length) return { ...e, attachments: refs(e.attachments) };
  // A tool's images too: a session that screenshots its work as it goes
  // would otherwise replay every one of them.
  if (e.kind === "tool_result" && e.images?.length) return { ...e, images: refs(e.images) };
  return e;
}
