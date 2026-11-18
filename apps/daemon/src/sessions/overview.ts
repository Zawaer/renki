import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The overview chat: one standing chat, pinned on Home, that knows about all
 * the others ("what am I working on?", "what's waiting on me?") and can start
 * or message them (claude/overviewTools.ts).
 *
 * It stays one chat in the app, but it doesn't keep one ever-growing Claude
 * conversation: each new day starts a fresh one, and what should outlive the
 * day lives in NOTES.md in the chat's folder, which Claude reads first and
 * keeps up to date. The live state of the other chats is looked up when asked,
 * never carried in the conversation. So months of use start each day from a
 * few thousand tokens.
 */

export const OVERVIEW_TITLE = "Overview";
export const NOTES_FILE = "NOTES.md";

type Stored = { sessionId: string | null; day: string | null };

export class OverviewStore {
  private state: Stored = { sessionId: null, day: null };

  constructor(private readonly file: string) {
    try {
      if (existsSync(file)) this.state = { ...this.state, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>) };
    } catch {
      // Unreadable: start over; the next open creates a new overview chat.
    }
  }

  get sessionId(): string | null {
    return this.state.sessionId;
  }

  setSession(id: string): void {
    this.state = { sessionId: id, day: null };
    this.save();
  }

  /**
   * Whether a prompt on `day` (YYYY-MM-DD, the user's zone) should start a
   * fresh conversation: the current one began on an earlier day. Records the
   * day either way.
   */
  startsNewDay(day: string): boolean {
    const fresh = this.state.day !== null && this.state.day !== day;
    if (this.state.day !== day) {
      this.state = { ...this.state, day };
      this.save();
    }
    return fresh;
  }

  private save(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.state));
    } catch {
      // Best effort: losing this only means one extra or one missed fresh start.
    }
  }
}

/** YYYY-MM-DD in `timeZone`. */
export function dayIn(timeZone: string, now = Date.now()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

/** The notes file a new overview chat starts with. */
export function seedNotes(dir: string): void {
  const path = resolve(dir, NOTES_FILE);
  if (existsSync(path)) return;
  writeFileSync(
    path,
    [
      "# Notes",
      "",
      "What the overview chat keeps between days. Edit freely.",
      "",
      "## Projects",
      "",
      "## Decisions",
      "",
      "## To do",
      "",
    ].join("\n"),
  );
}

/** What the overview chat is told on top of Renki's usual prompt. */
export function overviewPromptAppend(): string {
  return `

# This is the overview chat
This chat is the user's overview of all their other Renki chats: the place they ask "what am I working on?", "what's waiting on me?", "what did we decide about X?", or "start a chat in renki that does Y". You don't do project work here; you find, summarise, start and steer the chats that do.

- The state of the other chats changes all the time. Call list_chats whenever it matters, rather than trusting an earlier result. Read what was said in one with read_chat, find one by topic with search_chats.
- start_chat and send_to_chat act in the user's name and always ask them first. A new chat knows nothing of this one: give it the whole brief.
- Link chats as [@Title](renki://chat/<id>) so the user can open them.
- ${NOTES_FILE} in this folder is your memory between days: projects, decisions, the user's to-dos and anything they ask you to remember. Read it at the start of each conversation, and update it (with Edit) whenever something lasting changes. Keep it short and current: rewrite or drop stale entries instead of appending forever.
- Each day starts a fresh conversation here, so anything worth keeping beyond today belongs in ${NOTES_FILE}, not only in your replies. Yesterday's conversation is still readable with read_chat on this chat if needed.`;
}
