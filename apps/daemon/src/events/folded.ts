import { applyEvents, type ConversationState, initialConversation, latestOf, type TimelineItem } from "@renki/client-core";
import { withAttachmentRefs } from "./attachmentRefs.js";
import type { EventLog } from "./log.js";

/** How many chats stay folded in memory: the ones being opened right now, roughly. */
const KEEP = 4;

/**
 * Chats folded into the state a client renders, kept up to date on demand, so
 * opening one sends its latest turns at once instead of every event it ever
 * had (a long chat is tens of thousands of events and many megabytes, which
 * took seconds to send and fold on a phone). Attachments are by reference,
 * as in a lazy replay.
 *
 * Catching up is synchronous, like the event log: a caller that reads the
 * state and then switches a subscriber to live events can't miss one between.
 */
export class FoldedChats {
  /** Most recently used last. */
  private readonly chats = new Map<string, ConversationState>();

  constructor(private readonly events: EventLog) {}

  /** The whole folded chat, caught up to the log's head. */
  get(sessionId: string): ConversationState {
    let state = this.chats.get(sessionId) ?? initialConversation(sessionId);
    const missed = this.events.readLight(sessionId, state.lastSeq);
    if (missed.length > 0) state = applyEvents(state, missed.map(withAttachmentRefs));
    this.chats.delete(sessionId);
    this.chats.set(sessionId, state);
    while (this.chats.size > KEEP) this.chats.delete(this.chats.keys().next().value!);
    return state;
  }

  /** The chat with only its last `tail` timeline items, for a snapshot. */
  latest(sessionId: string, tail: number): ConversationState {
    return latestOf(this.get(sessionId), tail);
  }

  /** Up to `limit` items ending (exclusive) at index `end`, and where they start. */
  history(sessionId: string, end: number, limit: number): { items: TimelineItem[]; start: number } {
    const { timeline } = this.get(sessionId);
    const to = Math.max(0, Math.min(end, timeline.length));
    const start = Math.max(0, to - limit);
    return { items: timeline.slice(start, to), start };
  }

  /** A chat that's gone, or whose log was rewritten. */
  forget(sessionId: string): void {
    this.chats.delete(sessionId);
  }
}
