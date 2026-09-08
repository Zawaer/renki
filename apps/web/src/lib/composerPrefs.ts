import { resolveEffortKey, resolvePermissionMode, type PermissionModeKey } from "@renki/client-core";
import type { Attachment } from "@renki/protocol";

/**
 * The model / effort / permission mode a session's composer is set to,
 * persisted in localStorage so they survive a refresh instead of resetting.
 * Per-browser, not synced across devices.
 *
 * These are kept PER SESSION. Sessions are how work is separated here — a
 * cheap model chatting in one, Opus grinding through a refactor in another —
 * and a single global pick meant every switch between them silently re-armed
 * the composer with the other session's choice.
 *
 * A session that has never been set falls back to the last pick made anywhere,
 * so a new session starts from what you were last using rather than blank, and
 * diverges the moment you change it there.
 */
const MODE_KEY = "renki.permissionMode";
const EFFORT_KEY = "renki.effortKey";
const MODEL_KEY = "renki.model";

/** The session's own value, else the global "last used", else null. */
function readScoped(key: string, sessionId: string | null): string | null {
  try {
    const scoped = sessionId ? localStorage.getItem(`${key}.${sessionId}`) : null;
    return scoped ?? localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Fix a session's value the first time it's read, so it stops tracking picks
 * made elsewhere.
 *
 * Inheriting the last pick once, when a session is first opened, is the useful
 * half of a global default; inheriting forever is the bug — choosing Haiku in
 * one session would silently change what an untouched session sends. Only ever
 * writes the SESSION's key: the global stays whatever was last chosen
 * deliberately, so it's still what the next new session inherits.
 */
function pinScoped(key: string, sessionId: string | null, resolved: string): void {
  if (!sessionId) return;
  try {
    const k = `${key}.${sessionId}`;
    if (localStorage.getItem(k) === null) localStorage.setItem(k, resolved);
  } catch {
    /* storage unavailable — it just won't be remembered */
  }
}

/** Writes both the session's value and the global fallback for the next new session. */
function writeScoped(key: string, sessionId: string | null, value: string): void {
  try {
    if (sessionId) localStorage.setItem(`${key}.${sessionId}`, value);
    localStorage.setItem(key, value);
  } catch {
    // Quota or private mode — the picker still works for this session, it just
    // won't be remembered.
  }
}

export function loadPermissionMode(sessionId: string | null = null): PermissionModeKey {
  const resolved = resolvePermissionMode(readScoped(MODE_KEY, sessionId));
  pinScoped(MODE_KEY, sessionId, resolved);
  return resolved;
}

export function savePermissionMode(mode: PermissionModeKey, sessionId: string | null = null): void {
  writeScoped(MODE_KEY, sessionId, mode);
}

export function loadEffortKey(sessionId: string | null = null): string {
  const resolved = resolveEffortKey(readScoped(EFFORT_KEY, sessionId));
  pinScoped(EFFORT_KEY, sessionId, resolved);
  return resolved;
}

export function saveEffortKey(key: string, sessionId: string | null = null): void {
  writeScoped(EFFORT_KEY, sessionId, key);
}

/**
 * "" is a valid persisted value too — means "use the SDK's own default", same
 * as before anything's ever been picked. Deliberately NOT pinned when empty:
 * the composer fills an empty pick from capabilities, and pinning "" would
 * freeze a session onto whatever that list happened to start with.
 */
export function loadModel(sessionId: string | null = null): string {
  const resolved = readScoped(MODEL_KEY, sessionId) ?? "";
  if (resolved) pinScoped(MODEL_KEY, sessionId, resolved);
  return resolved;
}

export function saveModel(model: string, sessionId: string | null = null): void {
  writeScoped(MODEL_KEY, sessionId, model);
}

/** Drops a session's remembered picks — called when its transcript is deleted for good. */
export function clearComposerPrefs(sessionId: string): void {
  try {
    for (const key of [MODE_KEY, EFFORT_KEY, MODEL_KEY]) localStorage.removeItem(`${key}.${sessionId}`);
  } catch {
    /* storage unavailable — nothing to clear */
  }
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

const DRAFT_PREFIX = "renki.draft.";
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
