import type { GatewayApproval } from "@renki/protocol";
import { useEffect, useState } from "react";
import { useClient, useStoreValue } from "../lib/client.js";

/**
 * Homelab requests waiting for an approval (add-app, sh, sudo…), one slim line each on every page,
 * so a request isn't missed. "Approve" opens the approval service's own page (not Renki's: a chat
 * can drive Renki, so approving here needs Touch ID there); without a Mac set up for that, it's
 * the phone, and this can push the request to it again.
 */
export function PhoneApprovalBanner() {
  const { realtime } = useClient();
  const pending = useStoreValue(realtime.gatewayApprovals);
  const approvers = useStoreValue(realtime.gatewayApprovers);
  const url = useStoreValue(realtime.gatewayUrl);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!pending.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length]);

  const live = pending.filter((p) => p.expires > now);
  if (!live.length) return null;
  return (
    <div className="border-b border-(--renki-warning)/30 bg-(--renki-warning)/10 px-3" role="status" aria-live="polite">
      {live.map((p) => (
        <Row key={p.id} approval={p} now={now} approveUrl={approvers > 0 && url ? `${url}/r/${p.id}` : null} />
      ))}
    </div>
  );
}

function Row({ approval, now, approveUrl }: { approval: GatewayApproval; now: number; approveUrl: string | null }) {
  const { rest } = useClient();
  const [sent, setSent] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const left = Math.max(0, Math.round((approval.expires - now) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const root = /^Run as ROOT/.test(approval.summary);
  // The gateway's summary is "Run on the homelab as zawaer:\n<command>"; the command is what matters.
  const command = approval.summary.replace(/^Run (?:as ROOT )?on the homelab(?: as \w+)?:\s*/, "").replace(/\s*Enter your sudo password to approve\.$/, "");

  async function resend() {
    setSent("sending");
    try {
      await rest.resendGatewayApprovals();
      setSent("sent");
    } catch {
      setSent("failed");
    }
  }

  return (
    <div className="mx-auto flex h-8 w-full max-w-3xl items-center gap-2 text-xs text-(--renki-fg)" title={approval.summary}>
      <span className={`codicon ${root ? "codicon-shield" : "codicon-terminal"} shrink-0 text-[13px] text-(--renki-warning)`} />
      <span className="shrink-0 font-medium">{root ? "Root command" : "Approval"}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-(--renki-fg-muted)">{command.replace(/\s+/g, " ")}</span>
      <span className="shrink-0 font-mono text-[11px] text-(--renki-fg-muted) tabular-nums" title="Then it's denied">
        {clock}
      </span>
      {approveUrl && (
        <button
          type="button"
          onClick={() => window.open(approveUrl, `approve-${approval.id}`, "popup,width=600,height=640")}
          className="shrink-0 rounded-full bg-(--renki-accent) px-2.5 py-0.5 text-[11.5px] font-semibold text-(--renki-accent-fg) hover:brightness-105"
        >
          Approve
        </button>
      )}
      <button
        type="button"
        onClick={resend}
        disabled={sent === "sending"}
        className="shrink-0 text-[11.5px] text-(--renki-link) hover:underline disabled:opacity-50"
        title="Push it to the phone again (a swiped-away notification loses it)"
      >
        {sent === "sent" ? "Sent" : sent === "failed" ? "Retry" : approveUrl ? "Phone" : "Send to phone"}
      </button>
    </div>
  );
}

/**
 * While a homelab time window is open (`homelab open-window`: chats run host commands without
 * asking), a small chip in the sidebar's corner, with a way to end it early.
 */
export function HomelabWindowChip({ compact = false }: { compact?: boolean }) {
  const { realtime, rest } = useClient();
  const until = useStoreValue(realtime.gatewayWindow);
  const [now, setNow] = useState(Date.now());
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    if (until === null) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [until]);

  if (until === null || until <= now) return null;
  const at = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const title = `Chats run commands on the homelab without asking until ${at}. Click to end it now.`;

  async function end() {
    setEnding(true);
    try {
      await rest.closeGatewayWindow();
    } finally {
      setEnding(false);
    }
  }

  return (
    <button
      type="button"
      onClick={end}
      disabled={ending}
      title={title}
      className={`flex shrink-0 items-center gap-1 rounded-full border border-(--renki-warning)/40 bg-(--renki-warning)/10 text-[11px] text-(--renki-warning) hover:bg-(--renki-warning)/20 disabled:opacity-50 ${
        compact ? "h-6 w-6 justify-center" : "h-6 px-2"
      }`}
    >
      <span className="codicon codicon-unlock text-[11px]" />
      {!compact && <span className="tabular-nums">{at}</span>}
    </button>
  );
}
