import type { SessionStatus } from "@crc/protocol";
import { useEffect, useRef, useState } from "react";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
  /** `icon` is a square button for a single glyph. */
  size?: "sm" | "md" | "icon";
};

export function Button({ variant = "default", size = "md", className = "", ...props }: ButtonProps) {
  const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
    default: "border border-(--crc-border) bg-(--crc-surface) text-(--crc-fg) shadow-(--crc-shadow-xs) hover:bg-(--crc-hover)",
    primary: "bg-(--crc-accent) text-(--crc-accent-fg) shadow-(--crc-shadow-sm) hover:bg-(--crc-accent-hover)",
    ghost: "bg-transparent text-(--crc-fg-muted) hover:bg-(--crc-hover) hover:text-(--crc-fg)",
    danger: "bg-(--crc-danger)/12 text-(--crc-danger) hover:bg-(--crc-danger)/20",
  };
  const sizes: Record<NonNullable<ButtonProps["size"]>, string> = {
    sm: "h-7 rounded-md px-2.5 text-xs",
    md: "h-8 rounded-lg px-3.5 text-sm",
    icon: "h-8 w-8 rounded-lg p-0",
  };
  return (
    <button
      {...props}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 font-medium transition-[background-color,color,transform] duration-150 select-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}

const STATUS_COLOR: Record<SessionStatus, string> = {
  idle: "bg-(--crc-success)",
  busy: "bg-(--crc-warning) crc-glow-warning animate-pulse",
  error: "bg-(--crc-danger)",
  archived: "bg-(--crc-fg-muted)/60",
  // Never actually rendered — deleted sessions are excluded from listSessions()/getSession().
  deleted: "bg-(--crc-fg-muted)/60",
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  busy: "Working",
  error: "Error",
  archived: "Archived",
  deleted: "Deleted",
};

export function StatusDot({ status, pendingPermission }: { status: SessionStatus; pendingPermission?: boolean }) {
  if (pendingPermission && status === "busy") {
    return <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-(--crc-danger) crc-glow-danger animate-pulse" />;
  }
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_COLOR[status]}`} />;
}

/**
 * Session state as a glyph whose SHAPE changes, not just its color — an
 * outline for idle, a spinner while working, a shield when it needs you, a
 * cross on error, a box when archived. Reads at a glance and without color.
 */
export function SessionGlyph({ status, pendingPermission }: { status: SessionStatus; pendingPermission?: boolean }) {
  let icon: string;
  let tone: string;
  let label: string;
  if (pendingPermission && status === "busy") {
    icon = "codicon-shield animate-pulse";
    tone = "text-(--crc-danger)";
    label = "Needs your approval";
  } else if (status === "busy") {
    icon = "codicon-loading codicon-modifier-spin";
    tone = "text-(--crc-warning)";
    label = "Working";
  } else if (status === "error") {
    icon = "codicon-error";
    tone = "text-(--crc-danger)";
    label = "Error";
  } else if (status === "archived" || status === "deleted") {
    // Archived rows are already dimmed; a hollow dot is enough of a marker.
    return (
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" title="Archived" aria-label="Archived">
        <span className="h-1.5 w-1.5 rounded-full ring-1 ring-(--crc-fg-muted)/45 ring-inset" />
      </span>
    );
  } else {
    // Idle is the quiet default: a small filled dot, not an outlined circle —
    // a big hollow ring beside a label reads as an unchecked checkbox.
    return (
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" title="Idle" aria-label="Idle">
        <span className="h-1.5 w-1.5 rounded-full bg-(--crc-fg-muted)/60" />
      </span>
    );
  }
  return (
    <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${tone}`} title={label} aria-label={label}>
      <span className={`codicon ${icon} text-[13px]`} />
    </span>
  );
}

/**
 * Quiet status label: a dot and tinted text, no capsule — the Claude desktop
 * app's idiom. Turns red and says so when a permission is waiting.
 */
export function StatusBadge({ status, pendingPermission }: { status: SessionStatus; pendingPermission?: boolean }) {
  const needsYou = pendingPermission && status === "busy";
  const tone = needsYou
    ? "text-(--crc-danger)"
    : status === "busy"
      ? "text-(--crc-warning)"
      : status === "error"
        ? "text-(--crc-danger)"
        : "text-(--crc-fg-muted)";
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${tone}`}>
      <StatusDot status={status} pendingPermission={pendingPermission} />
      {needsYou ? "Needs your approval" : STATUS_LABEL[status]}
    </span>
  );
}

/** Uppercase section eyebrow — "Archived", "By repo", etc. */
export function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`text-[11px] font-semibold tracking-[0.08em] text-(--crc-fg-muted) uppercase ${className}`}>{children}</div>;
}

/**
 * Loading placeholder shaped like the content it stands in for. Size it with
 * Tailwind classes (`h-3 w-24`); it shimmers until the real thing renders.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`crc-skeleton block ${className}`} />;
}

export type SelectOption = { value: string; label: string; description?: string };

/**
 * A themed replacement for a native <select>: a field-shaped trigger and a
 * floating list with a check on the current value. Same look as the composer
 * pickers, so forms and the composer read as one system. Closes on outside
 * click and Escape; arrow keys move, Enter picks.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  disabled,
  className = "",
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (open) setCursor(Math.max(0, options.findIndex((o) => o.value === value)));
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(options.length - 1, c + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const picked = options[cursor];
        if (picked) onChange(picked.value);
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, options, cursor, onChange]);

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`crc-input flex items-center justify-between gap-2 text-left disabled:opacity-50 ${open ? "border-(--crc-accent)" : ""}`}
      >
        <span className={`truncate ${current ? "text-(--crc-fg)" : "text-(--crc-fg-muted)"}`}>{current?.label ?? placeholder}</span>
        <span className="codicon codicon-chevron-down shrink-0 text-[12px] text-(--crc-fg-muted)" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            ref={listRef}
            role="listbox"
            className="crc-enter absolute top-full left-0 z-50 mt-1.5 max-h-64 w-full overflow-y-auto rounded-xl bg-(--crc-surface) p-1 text-sm shadow-(--crc-shadow-lg)"
          >
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                onMouseEnter={() => setCursor(i)}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2 text-left ${
                  i === cursor ? "bg-(--crc-hover)" : ""
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-(--crc-fg)">{o.label}</span>
                  {o.description && <span className="block truncate text-xs text-(--crc-fg-muted)">{o.description}</span>}
                </span>
                {o.value === value && <span className="codicon codicon-check shrink-0 text-(--crc-fg)" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
