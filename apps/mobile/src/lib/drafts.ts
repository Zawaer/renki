import type { Attachment } from "@renki/client-core";
import * as FileSystem from "expo-file-system";

/**
 * What you typed into a chat and haven't sent, kept per chat so leaving it
 * (or the app being killed) doesn't lose it. Mirrors the web's drafts in
 * apps/web/src/lib/composerPrefs.ts.
 *
 * Stored as one small file per chat rather than in SecureStore, which is meant
 * for secrets and caps values at about 2KB: attachments are base64. A memory
 * copy answers instantly when you hop between chats; the file is what
 * survives a restart. A draft whose files make it too big keeps its text and
 * says the files were dropped, as on the web.
 */
export type ComposerDraft = {
  text: string;
  attachments: Attachment[];
  /** True when the text was kept but its attachments were too large to store. */
  attachmentsDropped: boolean;
};

/** Plenty for a message's text plus a few photos, without letting drafts pile up into real storage. */
const MAX_DRAFT_BYTES = 8_000_000;

const dir = `${FileSystem.documentDirectory}drafts/`;
const memory = new Map<string, ComposerDraft | null>();

function fileFor(sessionId: string): string {
  return `${dir}${encodeURIComponent(sessionId)}.json`;
}

export async function loadDraft(sessionId: string): Promise<ComposerDraft | null> {
  if (memory.has(sessionId)) return memory.get(sessionId) ?? null;
  try {
    const raw = await FileSystem.readAsStringAsync(fileFor(sessionId));
    const parsed = JSON.parse(raw) as Partial<ComposerDraft>;
    const text = typeof parsed.text === "string" ? parsed.text : "";
    const attachments = Array.isArray(parsed.attachments) ? (parsed.attachments as Attachment[]) : [];
    const draft = text || attachments.length > 0 ? { text, attachments, attachmentsDropped: parsed.attachmentsDropped === true } : null;
    memory.set(sessionId, draft);
    return draft;
  } catch {
    // No file yet is the usual case.
    memory.set(sessionId, null);
    return null;
  }
}

/** Fire-and-forget: a draft that fails to save is not worth interrupting typing for. */
export function saveDraft(sessionId: string, text: string, attachments: Attachment[]): void {
  if (!text.trim() && attachments.length === 0) return clearDraft(sessionId);
  let draft: ComposerDraft = { text, attachments, attachmentsDropped: false };
  let body = JSON.stringify(draft);
  if (body.length > MAX_DRAFT_BYTES) {
    draft = { text, attachments: [], attachmentsDropped: true };
    body = JSON.stringify(draft);
  }
  memory.set(sessionId, draft);
  void FileSystem.makeDirectoryAsync(dir, { intermediates: true })
    .catch(() => {})
    .then(() => FileSystem.writeAsStringAsync(fileFor(sessionId), body))
    .catch(() => {});
}

export function clearDraft(sessionId: string): void {
  memory.set(sessionId, null);
  void FileSystem.deleteAsync(fileFor(sessionId), { idempotent: true }).catch(() => {});
}
