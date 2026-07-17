import type { SessionStatus } from "@crc/protocol";

export function Button({
  variant = "default",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  const styles: Record<string, string> = {
    default: "bg-neutral-800 hover:bg-neutral-700 text-neutral-100 border border-neutral-700",
    primary: "bg-indigo-600 hover:bg-indigo-500 text-white",
    ghost: "bg-transparent hover:bg-neutral-800 text-neutral-300",
    danger: "bg-transparent hover:bg-red-950 text-red-400 border border-red-900/60",
  };
  return (
    <button
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
    />
  );
}

const STATUS_COLOR: Record<SessionStatus, string> = {
  idle: "bg-emerald-500",
  busy: "bg-amber-400 animate-pulse",
  error: "bg-red-500",
  archived: "bg-neutral-600",
};

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${STATUS_COLOR[status]}`} />;
}

export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
      <StatusDot status={status} />
      {status}
    </span>
  );
}
