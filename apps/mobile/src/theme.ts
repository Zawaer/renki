export const colors = {
  bg: "#0b0d10",
  panel: "#14171c",
  panel2: "#1b1f26",
  border: "#262b33",
  text: "#e5e7eb",
  dim: "#8b93a1",
  faint: "#5b626e",
  accent: "#6366f1",
  ok: "#10b981",
  busy: "#f59e0b",
  error: "#ef4444",
  danger: "#f87171",
};

export const statusColor: Record<string, string> = {
  idle: colors.ok,
  busy: colors.busy,
  error: colors.error,
  archived: colors.faint,
};
