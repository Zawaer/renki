import type { GatewayApproval } from "@renki/protocol";
import { useEffect, useState } from "react";
import { useClient, useStoreValue } from "../lib/client.js";

/**
 * Homelab requests waiting for the phone (add-app, rm-path…), shown on every
 * page so a request isn't missed while the phone sits elsewhere. Approving
 * stays on the phone; this only says what is waiting, how long is left, and
 * can push it to the phone again if the notification was swiped away.
 * Also says while a time window is open (`homelab open-window`: chats run host
 * commands without asking), with a button to end it.
 */
export function PhoneApprovalBanner() {
  const { realtime } = useClient();
  const pending = useStoreValue(realtime.gatewayApprovals);
  const windowUntil = useStoreValue(realtime.gatewayWindow);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!pending.length && windowUntil === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length, windowUntil]);

  const live = pending.filter((p) => p.expires > now);
  const windowOpen = windowUntil !== null && windowUntil > now;
  if (!live.length && !windowOpen) return null;
  return (
    <div className="border-b border-(--renki-warning)/40 bg-(--renki-warning)/12 px-4 py-2" role="status" aria-live="polite">
      {windowOpen && <WindowRow until={windowUntil} />}
      {live.map((p) => (
        <Row key={p.id} approval={p} now={now} />
      ))}
    </div>
  );
}

function WindowRow({ until }: { until: number }) {
  const { rest } = useClient();
  const [state, setState] = useState<"idle" | "ending" | "failed">("idle");
  const at = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  async function end() {
    setState("ending");
    try {
      await rest.closeGatewayWindow();
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 py-0.5 text-[13px] text-(--renki-fg)">
      <span className="codicon codicon-terminal shrink-0 text-[15px] text-(--renki-warning)" />
      <span className="font-medium">Homelab open</span>
      <span className="min-w-0 flex-1 basis-64 text-(--renki-fg-muted)">Chats run commands on the homelab without asking until {at}.</span>
      <button
        type="button"
        onClick={end}
        disabled={state === "ending"}
        className="shrink-0 text-xs text-(--renki-link) hover:underline disabled:opacity-50"
      >
        {state === "failed" ? "Couldn't end it. Retry" : "End now"}
      </button>
    </div>
  );
}

function Row({ approval, now }: { approval: GatewayApproval; now: number }) {
  const { rest } = useClient();
  const [sent, setSent] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const left = Math.max(0, Math.round((approval.expires - now) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;

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
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 py-0.5 text-[13px] text-(--renki-fg)">
      <span className="codicon codicon-device-mobile shrink-0 text-[15px] text-(--renki-warning)" />
      <span className="font-medium">Approve on your phone</span>
      <span className="min-w-0 flex-1 basis-64 text-(--renki-fg-muted)">{approval.summary}</span>
      <span className="font-mono text-xs text-(--renki-fg-muted) tabular-nums" title="Then it's denied">
        {clock}
      </span>
      <button
        type="button"
        onClick={resend}
        disabled={sent === "sending"}
        className="shrink-0 text-xs text-(--renki-link) hover:underline disabled:opacity-50"
      >
        {sent === "sent" ? "Sent again" : sent === "failed" ? "Couldn't send. Retry" : "Send to phone again"}
      </button>
    </div>
  );
}
