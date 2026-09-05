import type { UsageOrg } from "@crc/protocol";
import { useState } from "react";
import { useClient } from "../lib/client.js";

/**
 * "Connect usage %" affordance. Get a session key — paste one (a browser
 * can't read the httpOnly cookie itself, so this is manual) or guided login
 * (the daemon opens a real, headful browser on whatever host it's running
 * on and reads the cookie after you sign in — only works if that host has a
 * display). The daemon then returns the account's orgs; you pick which org's
 * usage to track, and we persist that choice. No auto-selection.
 */
export function UsageConnect({ configured, onConnected }: { configured: boolean; onConnected: () => void }) {
  const { rest } = useClient();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<null | "login" | "paste" | "pick">(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [orgs, setOrgs] = useState<UsageOrg[] | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  async function startBrowserLogin() {
    setBusy("login");
    setMsg({ ok: true, text: "Opening a browser on the daemon host — sign in there…" });
    try {
      const res = await rest.startUsageLogin();
      if (res.unavailable) {
        setMsg({ ok: false, text: "Guided login needs Playwright on the daemon host. Paste a key instead, or install it (see SETUP.md)." });
      } else if (res.orgs.length > 0 && res.sessionKey) {
        setPendingKey(res.sessionKey);
        setOrgs(res.orgs);
        setMsg(null);
      } else {
        setMsg({ ok: false, text: res.message ?? "Login failed." });
      }
    } catch {
      setMsg({ ok: false, text: "Could not reach the daemon." });
    } finally {
      setBusy(null);
    }
  }

  async function resolvePasted() {
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy("paste");
    setMsg(null);
    try {
      const res = await rest.connectUsageKey(trimmed);
      if (res.orgs.length > 0) {
        setPendingKey(trimmed);
        setOrgs(res.orgs);
      } else {
        setMsg({ ok: false, text: res.message ?? "That key didn't work." });
      }
    } catch {
      setMsg({ ok: false, text: "Could not reach the daemon." });
    } finally {
      setBusy(null);
    }
  }

  async function pickOrg(orgId: string) {
    if (!pendingKey) return;
    setBusy("pick");
    setMsg(null);
    try {
      const res = await rest.connectUsageKey(pendingKey, orgId);
      if (res.ok) {
        setKey("");
        setOrgs(null);
        setPendingKey(null);
        setOpen(false);
        onConnected();
      } else {
        setMsg({ ok: false, text: res.message ?? "Couldn't connect that org." });
      }
    } catch {
      setMsg({ ok: false, text: "Could not reach the daemon." });
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-[11px] text-(--crc-link) hover:underline"
      >
        {configured ? "+ Add usage account" : "Connect usage %"}
      </button>
    );
  }

  const fmt = (o: UsageOrg) =>
    o.usage ? `5h ${Math.round(o.usage.fiveHour.pct)}% · 7d ${Math.round(o.usage.sevenDay.pct)}%` : "no usage data";

  return (
    <div className="space-y-2 rounded-sm border border-(--crc-border) bg-(--crc-bg-inset) p-2.5">
      {orgs ? (
        <>
          <p className="text-[11px] text-(--crc-fg-muted)">Pick which organization's usage to track:</p>
          {orgs.map((o) => (
            <button
              key={o.orgId}
              onClick={() => pickOrg(o.orgId)}
              disabled={busy !== null}
              className="flex w-full items-center justify-between rounded-xl border border-(--crc-border) bg-(--crc-surface) px-2.5 py-1.5 text-left hover:border-(--crc-focus) disabled:opacity-40"
            >
              <span className="truncate text-[12px] text-(--crc-fg)">{o.name}</span>
              <span className="ml-2 shrink-0 text-[10px] text-(--crc-fg-muted)">{fmt(o)}</span>
            </button>
          ))}
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                setOrgs(null);
                setPendingKey(null);
              }}
              className="text-[11px] text-(--crc-fg-muted) hover:underline"
            >
              Back
            </button>
            {busy === "pick" && <span className="text-[11px] text-(--crc-fg-muted)">Connecting…</span>}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-(--crc-fg-muted)">Paste a session key</span>
            <button
              type="button"
              onClick={() => setShowHelp((v) => !v)}
              className="text-[10px] text-(--crc-link) hover:underline"
            >
              How to find the key
            </button>
          </div>
          {showHelp && (
            <ol className="list-decimal space-y-0.5 pl-4 text-[10px] leading-snug text-(--crc-fg-muted)">
              <li>Open claude.ai in any browser and make sure you're signed in.</li>
              <li>Open DevTools (Cmd+Option+I on Mac, F12 on Windows/Linux).</li>
              <li>
                Go to <span className="text-(--crc-fg)">Application</span> → Cookies →{" "}
                <span className="text-(--crc-fg)">https://claude.ai</span> (Firefox: Storage → Cookies).
              </li>
              <li>
                Copy the value of the <span className="text-(--crc-fg)">sessionKey</span> row — it starts with{" "}
                <span className="text-(--crc-fg)">sk-ant-sid…</span> — and paste it below.
              </li>
            </ol>
          )}
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-sid…"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-xl border border-(--crc-border) bg-(--crc-surface) px-2 py-1 text-[12px] text-(--crc-fg) outline-none focus:border-(--crc-focus)"
          />
          <div className="flex items-center justify-between">
            <button onClick={() => setOpen(false)} className="text-[11px] text-(--crc-fg-muted) hover:underline">
              Close
            </button>
            <button
              onClick={resolvePasted}
              disabled={busy !== null || key.trim().length === 0}
              className="rounded-sm border border-(--crc-border) px-2.5 py-1 text-[11px] text-(--crc-fg) hover:bg-(--crc-hover) disabled:opacity-40"
            >
              {busy === "paste" ? "Checking…" : "Next"}
            </button>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-(--crc-fg-muted)">
            <div className="h-px flex-1 bg-(--crc-border)" /> or <div className="h-px flex-1 bg-(--crc-border)" />
          </div>
          <button
            onClick={startBrowserLogin}
            disabled={busy !== null}
            className="w-full rounded-sm border border-(--crc-border) py-1.5 text-[12px] font-medium text-(--crc-fg) hover:bg-(--crc-hover) disabled:opacity-40"
          >
            {busy === "login" ? "Waiting for sign-in…" : "Sign in via browser (on daemon host)"}
          </button>
        </>
      )}
      {msg && <div className={`text-[11px] ${msg.ok ? "text-(--crc-success)" : "text-(--crc-danger)"}`}>{msg.text}</div>}
      <p className="text-[10px] leading-snug text-(--crc-fg-muted)">
        Read-only claude.ai session key (same one the Claude Usage app uses). Never touches your coding tokens.
      </p>
    </div>
  );
}
