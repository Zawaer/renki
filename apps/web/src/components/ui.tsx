import type { SessionStatus } from "@crc/protocol";

export function Button({
  variant = "default",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  const styles: Record<string, string> = {
    default:
      "bg-(--crc-input-bg) hover:bg-(--crc-hover) text-(--crc-fg) border border-(--crc-border)",
    primary: "bg-(--crc-accent) hover:bg-(--crc-accent-hover) text-(--crc-accent-fg)",
    ghost: "bg-transparent hover:bg-(--crc-hover) text-(--crc-fg-muted)",
    danger: "bg-transparent hover:bg-(--crc-danger)/15 text-(--crc-danger) border border-(--crc-danger)/40",
  };
  return (
    <button
      {...props}
      className={`rounded-sm px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
    />
  );
}

const STATUS_COLOR: Record<SessionStatus, string> = {
  idle: "bg-(--crc-success)",
  busy: "bg-(--crc-warning) animate-pulse",
  error: "bg-(--crc-danger)",
  archived: "bg-(--crc-fg-muted)",
};

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${STATUS_COLOR[status]}`} />;
}

export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm bg-(--crc-bg-elevated) px-2 py-0.5 text-xs text-(--crc-fg-muted)">
      <StatusDot status={status} />
      {status}
    </span>
  );
}
