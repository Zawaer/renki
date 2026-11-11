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
  /** When `homelab sh` stops running without asking (ms), or null: see `homelab open-window`. */
  private windowUntil: number | null = null;
  /** How many devices can approve with Touch ID (0 = only the phone). */
  private approverCount = 0;
  /** The approval service's own address, where a browser approves with Touch ID (https://approvals.internal). */
  private publicUrl: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(pending: GatewayApproval[], window: number | null, approvers: number) => void>();
  private failing = false;

  constructor(
    private readonly baseUrl: string,
    private readonly intervalMs = 3_000,
    private readonly fetchImpl: typeof fetch = fetch,
    /**
     * True while a computer has Renki open (a connected device that isn't a phone). Reported with
     * each poll, so the gateway holds the phone's notification back for a bit: approve on the Mac
     * and the phone never buzzes. Faking it could only delay a notification, never hide it.
     */
    private readonly desktopOnline: () => boolean = () => false,
  ) {}

  approvers(): number {
    return this.approverCount;
  }

  /** Where a browser opens a request to approve it with Touch ID: `${url}/r/<id>`. Null until known. */
  url(): string | null {
    return this.publicUrl;
  }

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

  window(): number | null {
    return this.windowUntil !== null && this.windowUntil > Date.now() ? this.windowUntil : null;
  }

  onChange(cb: (pending: GatewayApproval[], window: number | null, approvers: number) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async poll(): Promise<void> {
    let next: GatewayApproval[];
    let nextWindow: number | null;
    let nextApprovers = this.approverCount;
    try {
      const query = this.desktopOnline() ? "?desktop=1" : "";
      const res = await this.fetchImpl(`${this.baseUrl}/v1/approvals/pending${query}`, { signal: AbortSignal.timeout(2_500) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        pending?: { id: string; verb: string; summary: string; created: number; expires: number }[];
        window?: number | null;
        approvers?: number;
        url?: string | null;
      };
      if (typeof body.url === "string" && /^https:\/\/[a-z0-9.-]+$/.test(body.url)) this.publicUrl = body.url;
      nextApprovers = typeof body.approvers === "number" ? body.approvers : 0;
      nextWindow = typeof body.window === "number" ? body.window * 1000 : null;
      next = (body.pending ?? []).map((p) => ({ id: p.id, verb: p.verb, summary: p.summary, created: p.created * 1000, expires: p.expires * 1000 }));
      if (this.failing) logger.info("gateway approvals reachable again");
      this.failing = false;
    } catch (err) {
      if (!this.failing) logger.warn("can't list gateway approvals", { err: String(err) });
      this.failing = true;
      next = this.current(); // keep what we knew until each one expires
      nextWindow = this.window();
    }
    const key = (l: GatewayApproval[]) => l.map((p) => p.id).join(",");
    if (key(next) === key(this.pending) && nextWindow === this.windowUntil && nextApprovers === this.approverCount) return;
    this.pending = next;
    this.windowUntil = nextWindow;
    this.approverCount = nextApprovers;
    for (const cb of this.listeners) cb(next, nextWindow, nextApprovers);
  }

  /** End an open time window now. Needs no token on the gateway's side: it only takes access away. */
  async closeWindow(): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/window/close`, { method: "POST", signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await this.poll();
  }

  /** Push every waiting request to the phone again (a notification swiped away loses its token). */
  async resend(): Promise<number> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/approvals/resend`, { method: "POST", signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { pending?: number }).pending ?? 0;
  }
}
