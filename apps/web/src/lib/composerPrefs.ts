import { resolveEffortKey, resolvePermissionMode, type PermissionModeKey } from "@crc/client-core";
import type { Attachment } from "@crc/protocol";

/**
 * Last model/effort/permission-mode picked in the composer, persisted in
 * localStorage so they survive a refresh/reopen instead of resetting to
 * their defaults every time. Per-browser, not synced across devices.
 */
const MODE_KEY = "crc.permissionMode";
const EFFORT_KEY = "crc.effortKey";
const MODEL_KEY = "crc.model";

export function loadPermissionMode(): PermissionModeKey {
  return resolvePermissionMode(localStorage.getItem(MODE_KEY));
}

export function savePermissionMode(mode: PermissionModeKey): void {
  localStorage.setItem(MODE_KEY, mode);
}

export function loadEffortKey(): string {
  return resolveEffortKey(localStorage.getItem(EFFORT_KEY));
}

export function saveEffortKey(key: string): void {
  localStorage.setItem(EFFORT_KEY, key);
}

/** "" is a valid persisted value too — means "use the SDK's own default", same as before anything's ever been picked. */
export function loadModel(): string {
  return localStorage.getItem(MODEL_KEY) ?? "";
}

export function saveModel(model: string): void {
  localStorage.setItem(MODEL_KEY, model);
}

/**
 * The half-written prompt in a session's composer, kept per session so
 * switching away — or closing the tab entirely — doesn't throw away what you
 * were typing. Attachments come too, since re-picking a screenshot is worse
 * than retyping a sentence.
 *
 * Attachments are base64, and localStorage is a few megabytes in total, so a
 * draft over `MAX_DRAFT_BYTES` keeps its text and drops its files rather than
 * failing to save anything (or evicting other drafts). The restored draft says
 * so, so the loss is never silent.
 */
export type ComposerDraft = {
  text: string;
  attachments: Attachment[];
  /** True when the text was kept but its attachments were too large to store. */
  attachmentsDropped: boolean;
};

const DRAFT_PREFIX = "crc.draft.";
/** Well inside a typical 5MB localStorage budget, leaving room for other sessions' drafts. */
const MAX_DRAFT_BYTES = 1_500_000;

function draftKey(sessionId: string): string {
  return `${DRAFT_PREFIX}${sessionId}`;
}

export function loadDraft(sessionId: string): ComposerDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ComposerDraft>;
    const text = typeof parsed.text === "string" ? parsed.text : "";
    const attachments = Array.isArray(parsed.attachments) ? (parsed.attachments as Attachment[]) : [];
    if (!text && attachments.length === 0) return null;
    return { text, attachments, attachmentsDropped: parsed.attachmentsDropped === true };
  } catch {
    return null;
  }
}

export function saveDraft(sessionId: string, text: string, attachments: Attachment[]): void {
  if (!text.trim() && attachments.length === 0) {
    clearDraft(sessionId);
    return;
  }
  const full = JSON.stringify({ text, attachments, attachmentsDropped: false });
  try {
    if (full.length <= MAX_DRAFT_BYTES) {
      localStorage.setItem(draftKey(sessionId), full);
      return;
    }
    localStorage.setItem(draftKey(sessionId), JSON.stringify({ text, attachments: [], attachmentsDropped: attachments.length > 0 }));
  } catch {
    // Quota or private mode: try text alone, then give up quietly — a lost
    // draft is a nuisance, an exception mid-keystroke is worse.
    try {
      localStorage.setItem(draftKey(sessionId), JSON.stringify({ text, attachments: [], attachmentsDropped: attachments.length > 0 }));
    } catch {
      /* nothing more to try */
    }
  }
}

export function clearDraft(sessionId: string): void {
  try {
    localStorage.removeItem(draftKey(sessionId));
  } catch {
    /* storage unavailable — nothing to clear */
  }
}
