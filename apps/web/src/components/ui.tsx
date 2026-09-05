import type { SessionStatus } from "@crc/protocol";

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
    icon = "codicon-archive";
    tone = "text-(--crc-fg-muted)/70";
    label = "Archived";
  } else {
    icon = "codicon-circle-large-outline";
    tone = "text-(--crc-fg-muted)";
    label = "Idle";
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
