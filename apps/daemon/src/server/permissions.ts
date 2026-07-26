import type { PermissionDecision } from "@crc/protocol";
import { logger } from "../logger.js";
import type { PermissionOutcome, PermissionRequest } from "../claude/runner.js";

/**
 * Bridges a running turn's permission check to a human answer arriving later
 * over WebSocket.
 *
 * When Claude wants to use a gated tool, the runner calls our resolver, which
 * registers a pending promise here and emits a `permission_request` event to
 * all viewers. The turn's async loop simply awaits that promise. Later, the
 * controller's `resolve_permission` message calls answer(), which settles the
 * promise and lets the turn continue.
 *
 * Safety net: if nobody answers within the timeout, we auto-DENY. A stuck
 * permission must never hang a session forever, and denying is the safe default
 * (Claude gets told "no" and can carry on or stop).
 */
export class PermissionBroker {
  private readonly pending = new Map<
    string,
    { sessionId: string; settle: (o: PermissionOutcome) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly timeoutMs: number) {}

  /** The resolver handed to the runner for a given session. */
  resolverFor(sessionId: string): (req: PermissionRequest) => Promise<PermissionOutcome> {
    return (req) =>
      new Promise<PermissionOutcome>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(req.requestId);
          logger.warn("permission timed out; denying", { sessionId, requestId: req.requestId });
          resolve({ decision: "deny", byDeviceId: null });
        }, this.timeoutMs);
        // Unref so a pending permission never keeps the process alive on its own.
        timer.unref?.();

        this.pending.set(req.requestId, { sessionId, settle: resolve, timer });
      });
  }

  /** Called by the WS layer when the controller answers. Returns true if it matched. */
  answer(
    requestId: string,
    decision: PermissionDecision,
    byDeviceId: string,
    updatedInput?: Record<string, unknown>,
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.settle({ decision, byDeviceId, updatedInput });
    return true;
  }

  /** True if this request id is one this broker is currently waiting on. */
  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** The session a pending request belongs to (for controller validation). */
  sessionOf(requestId: string): string | undefined {
    return this.pending.get(requestId)?.sessionId;
  }
}
