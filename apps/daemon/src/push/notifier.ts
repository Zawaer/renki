import { classifyRateLimit } from "../claude/runner.js";
import { describeTool, parseAskUserQuestion } from "@renki/client-core";
import type { Session, SessionEvent } from "@renki/protocol";
import type { Config } from "../config.js";
import { logger } from "../logger.js";
import type { SessionManager } from "../sessions/manager.js";
import type { DeviceRegistry } from "./devices.js";
import type { PushTokenStore } from "./tokens.js";

/**
 * Android notification channels the app creates (see apps/mobile's push.ts):
 * "input" for anything waiting on you — loud, high priority — and "updates"
 * for news that can wait, like a long turn finishing.
 */
export type PushChannel = "input" | "updates";

export type PushMessage = {
  title: string;
  body: string;
  channel: PushChannel;
  /** Something is waiting on the user, rather than just news. */
  needsInput: boolean;
  /** Set for a permission request, so a push can be cancelled if it's answered first. */
  requestId?: string;
};

/** A turn shorter than this was probably watched as it ran; its "done" isn't worth a buzz. */
export const LONG_TURN_MS = 60_000;

/**
 * When someone is actively driving the session from a connected device, wait
 * this long before buzzing the phone about a request: answered on the laptop
 * by then, it never needs to reach the phone at all.
 */
export const NEEDS_INPUT_GRACE_MS = 15_000;

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** What the session is called in a notification: its title, else its repo. */
function nameOf(session: Session): string {
  return session.title || session.repoName;
}

/**
 * What to tell the phone about an event, or null when it isn't worth a push.
 *
 * Worth one: anything waiting on you (a question, an approval, a plan), a
 * long turn finishing or failing, and a turn pausing on a usage limit. Not
 * worth one: short turns, a stopped turn, and a rate-limited failure — the
 * pause notice that follows says what's actually happening.
 *
 * `replyExcerpt` is the start of the turn's final text, for a "done" push.
 */
export function composePush(event: SessionEvent, session: Session, replyExcerpt: string | null = null): PushMessage | null {
  const name = nameOf(session);
  switch (event.kind) {
    case "permission_request": {
      const base = { channel: "input" as const, needsInput: true, requestId: event.requestId };
      if (event.toolName === "AskUserQuestion") {
        const q = parseAskUserQuestion(event.toolName, event.toolInput);
        const first = q?.questions[0]?.question;
        const more = q && q.questions.length > 1 ? ` (+${q.questions.length - 1} more)` : "";
        return { ...base, title: `Question · ${name}`, body: first ? clip(first, 160) + more : "Claude has a question for you." };
      }
      if (event.toolName === "ExitPlanMode") {
        return { ...base, title: `Plan ready · ${name}`, body: "Claude has a plan and wants your go-ahead." };
      }
      const { label, meta } = describeTool(event.toolName, event.toolInput);
      if (event.toolName === "Bash") {
        const command = (event.toolInput as { command?: unknown } | null)?.command;
        const detail = meta ?? (typeof command === "string" ? command : label);
        return { ...base, title: `Approve a command? · ${name}`, body: clip(label === "Ran a command" ? detail : label, 160) };
      }
      if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(event.toolName)) {
        return { ...base, title: `Approve an edit? · ${name}`, body: clip(`${label} ${meta ?? ""}`, 160) };
      }
      return { ...base, title: `Permission needed · ${name}`, body: clip(meta ? `${label}: ${meta}` : `Claude wants to use ${event.toolName}`, 160) };
    }

    case "turn_result": {
      if (event.interrupted) return null;
      if (event.ok) {
        if ((event.durationMs ?? 0) < LONG_TURN_MS) return null;
        return { title: `Done · ${name}`, body: replyExcerpt ? clip(replyExcerpt, 180) : "Claude finished.", channel: "updates", needsInput: false };
      }
      // A usage limit is followed by a pause notice (or a "stopped retrying"
      // one); that's the push worth sending, not this.
      if (classifyRateLimit(event.errorMessage)) return null;
      return { title: `Turn failed · ${name}`, body: clip(event.errorMessage ?? "The turn errored.", 180), channel: "updates", needsInput: false };
    }

    case "notice": {
      if (event.text.startsWith("Paused on a usage limit")) {
        return { title: `Paused on a limit · ${name}`, body: clip(event.text.replace(/^Paused on a usage limit\.\s*/, ""), 180), channel: "updates", needsInput: false };
      }
      if (event.text.includes("stopped retrying")) {
        return { title: `Stopped on a limit · ${name}`, body: clip(event.text, 180), channel: "updates", needsInput: true };
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Turns session events into Expo push notifications for the phone.
 *
 * Who gets one: every registered device that isn't connected right now. A
 * connected device already sees everything live. It used to be only the
 * session's controller, which meant a session started on the laptop never
 * reached the phone at all — exactly when you'd walked away from the laptop.
 *
 * A request waiting on you, while some device is actively controlling the
 * session, gets a short grace period first: answer it there and the phone
 * stays quiet. Fire-and-forget: a push failure never affects the session.
 */
export class Notifier {
  /** requestId -> the delayed push for it, cancelled if it's answered first. */
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: Config,
    private readonly manager: SessionManager,
    private readonly devices: DeviceRegistry,
    private readonly tokens: PushTokenStore,
  ) {}

  /** Attach to the event log. Returns an unsubscribe fn. */
  attach(): () => void {
    return this.manager.events.onAny((event) => this.onEvent(event));
  }

  private onEvent(event: SessionEvent): void {
    if (event.kind === "permission_resolved") {
      const timer = this.pending.get(event.requestId);
      if (timer) clearTimeout(timer);
      this.pending.delete(event.requestId);
      return;
    }
    if (event.kind !== "permission_request" && event.kind !== "turn_result" && event.kind !== "notice") return;

    let session: Session;
    try {
      session = this.manager.getSession(event.sessionId);
    } catch {
      return;
    }
    const excerpt = event.kind === "turn_result" && event.ok ? this.replyExcerpt(event.sessionId, event.turnId) : null;
    const message = composePush(event, session, excerpt);
    if (!message) return;

    const driving = session.controller != null && this.devices.isOnline(session.controller);
    if (message.requestId && driving) {
      const requestId = message.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        void this.deliver(message, event.sessionId);
      }, NEEDS_INPUT_GRACE_MS);
      timer.unref();
      this.pending.set(requestId, timer);
      return;
    }
    void this.deliver(message, event.sessionId);
  }

  /** The start of a turn's last text block — what a "done" push shows. */
  private replyExcerpt(sessionId: string, turnId: string): string | null {
    const events = this.manager.events.read(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === "assistant_block" && e.turnId === turnId && e.blockKind === "text" && !e.parentToolUseId && e.text) return e.text;
    }
    return null;
  }

  /** Send to every registered device that isn't connected. */
  private async deliver(message: PushMessage, sessionId: string): Promise<void> {
    const targets = this.tokens.all().filter((t) => !this.devices.isOnline(t.deviceId));
    if (targets.length === 0) return;
    await this.send(targets, message, { sessionId });
  }

  /** A test push to one device, so Settings can show the whole path works. */
  async sendTest(deviceId: string): Promise<{ ok: boolean; error: string | null }> {
    const token = this.tokens.get(deviceId);
    if (!token) return { ok: false, error: "This device hasn't registered for notifications." };
    const [result] = await this.send([token], { title: "Renki", body: "Notifications work. You'll hear from sessions that need you.", channel: "input", needsInput: true }, {});
    return result ?? { ok: false, error: "No response from the push service." };
  }

  private async send(
    targets: { deviceId: string; expoToken: string }[],
    m: PushMessage,
    data: Record<string, string>,
  ): Promise<{ ok: boolean; error: string | null }[]> {
    const body = targets.map((t) => ({
      to: t.expoToken,
      title: m.title,
      body: m.body,
      data,
      priority: m.needsInput ? "high" : "normal",
      channelId: m.channel,
      sound: m.needsInput ? "default" : undefined,
    }));
    try {
      const res = await fetch(this.config.expoPushUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        logger.warn("expo push non-ok", { status: res.status });
        return targets.map(() => ({ ok: false, error: `Push service answered ${res.status}.` }));
      }
      const json = (await res.json().catch(() => null)) as { data?: { status?: string; message?: string; details?: { error?: string } }[] } | null;
      return targets.map((t, i) => {
        const ticket = json?.data?.[i];
        if (!ticket || ticket.status === "ok") return { ok: true, error: null };
        // The app was uninstalled or its token rotated: stop sending to it.
        if (ticket.details?.error === "DeviceNotRegistered") this.tokens.set(t.deviceId, "");
        logger.warn("expo push rejected", { deviceId: t.deviceId, error: ticket.details?.error, message: ticket.message });
        return { ok: false, error: ticket.message ?? ticket.details?.error ?? "Rejected by the push service." };
      });
    } catch (err) {
      logger.warn("expo push failed", { err: String(err) });
      return targets.map(() => ({ ok: false, error: "Couldn't reach the push service." }));
    }
  }
}
