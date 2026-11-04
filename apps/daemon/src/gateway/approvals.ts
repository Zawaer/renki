import type { GatewayApproval } from "@renki/protocol";
import { logger } from "../logger.js";

/**
 * Homelab gateway requests waiting for the user's phone, so every open tab can
 * say so: a request is easy to miss when the only sign is a notification on a
 * phone in another room, and it expires in five minutes.
 *
 * Polls the approval service's /v1/approvals/pending (ops/homelab-gateway),
 * which lists summaries only, never tokens: approving stays on the phone. A
 * poll that fails keeps the last list until it goes stale, then clears it.
 */
export class GatewayApprovals {
  private pending: GatewayApproval[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(pending: GatewayApproval[]) => void>();
  private failing = false;

  constructor(
    private readonly baseUrl: string,
    private readonly intervalMs = 3_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      void this.poll().finally(() => {
        if (this.timer) this.timer = setTimeout(tick, this.intervalMs);
      });
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  current(): GatewayApproval[] {
    return this.pending.filter((p) => p.expires > Date.now());
  }

  onChange(cb: (pending: GatewayApproval[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async poll(): Promise<void> {
    let next: GatewayApproval[];
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/approvals/pending`, { signal: AbortSignal.timeout(2_500) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { pending?: { id: string; verb: string; summary: string; created: number; expires: number }[] };
      next = (body.pending ?? []).map((p) => ({ id: p.id, verb: p.verb, summary: p.summary, created: p.created * 1000, expires: p.expires * 1000 }));
      if (this.failing) logger.info("gateway approvals reachable again");
      this.failing = false;
    } catch (err) {
      if (!this.failing) logger.warn("can't list gateway approvals", { err: String(err) });
      this.failing = true;
      next = this.current(); // keep what we knew until each one expires
    }
    const key = (l: GatewayApproval[]) => l.map((p) => p.id).join(",");
    if (key(next) === key(this.pending)) return;
    this.pending = next;
    for (const cb of this.listeners) cb(next);
  }

  /** Push every waiting request to the phone again (a notification swiped away loses its token). */
  async resend(): Promise<number> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/approvals/resend`, { method: "POST", signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { pending?: number }).pending ?? 0;
  }
}
