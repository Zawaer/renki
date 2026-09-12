import { resolveEffortKey, resolvePermissionMode, type PermissionModeKey } from "@renki/client-core";
import type { Attachment } from "@renki/protocol";

/**
 * This BROWSER's default model / effort / permission mode: the values a NEW
 * session is created with.
 *
 * These used to be the composer's state itself, kept per session in
 * localStorage. That made the settings a property of the device rather than of
 * the work: a session started on a phone opened on a laptop with whatever that
 * laptop last used, and the two devices could disagree about what a session was
 * set to. They now live on the session, served by the daemon (see
 * SessionComposer in @renki/protocol), and what's left here is only the seed.
 *
 * "Default" is simply the last pick made anywhere in this browser, since
 * there's no separate settings screen for it. So choosing Opus in one session
 * means the next new session starts on Opus — but it never reaches back into
 * sessions that already exist, including this one's siblings.
 */
const MODE_KEY = "renki.permissionMode";
const EFFORT_KEY = "renki.effortKey";
const MODEL_KEY = "renki.model";

export type DeviceComposerDefaults = {
  /** "" means "no pick yet" — the composer fills it from capabilities. */
  model: string;
  effortKey: string;
  permissionMode: PermissionModeKey;
};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** What a new session should start with, resolved against the known vocabularies. */
export function loadDeviceDefaults(): DeviceComposerDefaults {
  return {
    model: read(MODEL_KEY) ?? "",
    effortKey: resolveEffortKey(read(EFFORT_KEY)),
    permissionMode: resolvePermissionMode(read(MODE_KEY)),
  };
}

/**
 * Record a pick as this browser's new default. Called alongside the write that
 * pins the value onto the session, so the next new session inherits what you
 * were last using — the one useful half of the old global behaviour.
 */
export function rememberDeviceDefaults(patch: {
  model?: string;
  effortKey?: string;
  permissionMode?: PermissionModeKey;
}): void {
  try {
    if (patch.model !== undefined) localStorage.setItem(MODEL_KEY, patch.model);
    if (patch.effortKey !== undefined) localStorage.setItem(EFFORT_KEY, patch.effortKey);
    if (patch.permissionMode !== undefined) localStorage.setItem(MODE_KEY, patch.permissionMode);
  } catch {
    // Quota or private mode — the picker still works, the next new session
    // just won't inherit this pick.
  }
}

/**
 * Drop the per-session keys the old scheme wrote. Nothing reads them any more,
 * so this is pure tidying: called when a session's transcript is deleted for
 * good, the same as its draft.
 */
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
