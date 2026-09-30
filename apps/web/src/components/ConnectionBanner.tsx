import { UNREACHABLE_AFTER_MS, describeUnreachable } from "@renki/client-core";
import { useEffect, useState } from "react";
import { useClient, useStoreValue } from "../lib/client.js";
import { Button } from "./ui.js";

/**
 * "Can't reach your Renki host" — shown when the live connection has been
 * down for a while, so an empty or frozen screen explains itself. Waits
 * UNREACHABLE_AFTER_MS first: a laptop waking or a network switch reconnects
 * within seconds, and a banner for every blip would be noise. Goes away by
 * itself the moment the connection is back.
 */
export function ConnectionBanner() {
  const { realtime, config } = useClient();
  const status = useStoreValue(realtime.status);
  const [down, setDown] = useState(false);

  useEffect(() => {
    if (status === "open") {
      setDown(false);
      return;
    }
    const t = setTimeout(() => setDown(true), UNREACHABLE_AFTER_MS);
    return () => clearTimeout(t);
  }, [status]);

  if (!down || status === "open") return null;
  const { title, body } = describeUnreachable(config.baseUrl);
  return (
    <div role="status" className="renki-enter px-6 pt-3">
      <div className="mx-auto flex w-full max-w-3xl items-start gap-3 rounded-xl border border-(--renki-warning)/30 bg-(--renki-warning)/10 px-4 py-3">
        <span className="codicon codicon-debug-disconnect mt-0.5 text-[16px] text-(--renki-warning)" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-(--renki-fg)">{title}</div>
          <div className="mt-0.5 text-xs text-(--renki-fg-muted)">{body}</div>
        </div>
        <Button size="sm" onClick={() => realtime.reconnect()}>
          {status === "connecting" ? "Connecting…" : "Try again"}
        </Button>
      </div>
    </div>
  );
}
