import { formatResetTime, usageSeverity } from "@crc/client-core";
import type { AccountUsage, AccountUsageExtra, AccountUsageLimit } from "@crc/protocol";

/**
 * A plan's usage, one card per window claude.ai actually reports.
 *
 * There are three at once — a 5-hour rolling session window, a weekly cap
 * across all models, and a separate weekly cap for a premium model like Opus
 * or Fable — and any one of them can be what stops the next prompt. CRC used
 * to show only the first two, so a model-specific allowance running out was
 * invisible until a turn failed.
 *
 * Colour comes from claude.ai's own `severity` rather than a threshold we
 * invented, so "critical" means what it means on their side.
 */

const TONE: Record<"normal" | "warning" | "critical", { bar: string; text: string }> = {
  normal: { bar: "bg-(--crc-success)", text: "text-(--crc-success)" },
  warning: { bar: "bg-(--crc-warning)", text: "text-(--crc-warning)" },
  critical: { bar: "bg-(--crc-danger)", text: "text-(--crc-danger)" },
};

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-(--crc-bg-inset)">
      <div className={`h-full rounded-full transition-[width] duration-500 ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function LimitCard({ limit }: { limit: AccountUsageLimit }) {
  const pct = Math.max(0, Math.min(100, limit.pct));
  const tone = TONE[usageSeverity(limit.severity, pct)];
  // claude.ai reports no reset time for a window that hasn't started — an
  // untouched 5-hour window, or anything on an account with no activity this
  // period. Saying why beats leaving a gap where every other card has a line,
  // which reads as data that failed to load.
  const reset =
    formatResetTime(limit.resetsAt) ??
    (limit.kind === "session" ? "Starts on your next prompt" : "Nothing used yet");
  // "Weekly" for the two weekly windows; the 5-hour one explains itself below.
  const badge = limit.kind.startsWith("weekly") ? "Weekly" : null;

  return (
    <div className="rounded-xl bg-(--crc-bg-inset)/60 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-(--crc-fg)">{limit.label}</span>
          {badge && (
            <span className="shrink-0 rounded-md bg-(--crc-surface) px-1.5 py-px text-[10px] text-(--crc-fg-muted)">{badge}</span>
          )}
        </span>
        <span className={`shrink-0 text-[13px] font-semibold tabular-nums ${tone.text}`}>{Math.round(pct)}%</span>
      </div>
      {limit.kind === "session" && <div className="mt-0.5 text-[11px] text-(--crc-fg-muted)">5-hour rolling window</div>}
      <div className="mt-2">
        <Bar pct={pct} tone={tone.bar} />
      </div>
      <div className="mt-1.5 text-[11px] text-(--crc-fg-muted)">{reset}</div>
    </div>
  );
}

function formatUsd(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ExtraCard({ extra }: { extra: AccountUsageExtra }) {
  const pct = Math.max(0, Math.min(100, extra.pct));
  // Only rendered when the plan actually has credits enabled — the daemon
  // returns null otherwise (see parseExtra), so an org without them shows
  // nothing rather than an empty "0.00 / 0.00" meter.
  const tone = TONE[usageSeverity(extra.severity, pct)];
  return (
    <div className="rounded-xl bg-(--crc-bg-inset)/60 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-(--crc-fg)">Extra usage</span>
        <span className={`shrink-0 text-[13px] font-semibold tabular-nums ${tone.text}`}>{Math.round(pct)}%</span>
      </div>
      <div className="mt-0.5 text-[11px] text-(--crc-fg-muted)">
        {formatUsd(extra.usedDollars)} / {formatUsd(extra.limitDollars)} {extra.currency}
      </div>
      <div className="mt-2">
        <Bar pct={pct} tone={tone.bar} />
      </div>
    </div>
  );
}

/**
 * Falls back to the two headline windows when `limits` is empty, which happens
 * on an older claude.ai response shape.
 */
function limitsOf(usage: AccountUsage): AccountUsageLimit[] {
  // Optional: an older daemon predates the field entirely, and a crash here
  // would take the whole accounts panel down with it.
  if (usage.limits?.length) return usage.limits;
  return [
    { kind: "session", label: "Session usage", model: null, pct: usage.fiveHour.pct, resetsAt: usage.fiveHour.resetsAt, severity: "", isActive: true },
    { kind: "weekly_all", label: "All models", model: null, pct: usage.sevenDay.pct, resetsAt: usage.sevenDay.resetsAt, severity: "", isActive: false },
  ];
}

export function UsageLimits({ usage, className = "" }: { usage: AccountUsage; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {limitsOf(usage).map((l) => (
        <LimitCard key={`${l.kind}:${l.model ?? ""}`} limit={l} />
      ))}
      {usage.extra && <ExtraCard extra={usage.extra} />}
    </div>
  );
}

/** The single most constraining figure across every window — what the sidebar badge shows. */
export function worstUsagePct(usage: AccountUsage | null): { pct: number; severity: "normal" | "warning" | "critical" } | null {
  if (!usage) return null;
  const all = limitsOf(usage);
  if (all.length === 0) return null;
  const worst = all.reduce((a, b) => (b.pct > a.pct ? b : a));
  return { pct: worst.pct, severity: usageSeverity(worst.severity, worst.pct) };
}
