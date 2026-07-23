/**
 * Permission modes, mirroring Claude Code's own Manual/Edit automatically/
 * Plan/Auto mode selector. Each maps 1:1 to one of the Agent SDK's
 * `PermissionMode` literals — the two SDK modes we don't expose here
 * (`bypassPermissions`, `dontAsk`) skip tool-execution safety checks
 * entirely, which shouldn't be a casual per-message toggle.
 */
export type PermissionModeKey = "default" | "acceptEdits" | "plan" | "auto";

export type PermissionModeOption = {
  key: PermissionModeKey;
  label: string;
  description: string;
};

export const PERMISSION_MODES: PermissionModeOption[] = [
  { key: "default", label: "Manual", description: "Ask for approval before every gated tool call." },
  {
    key: "acceptEdits",
    label: "Edit automatically",
    description: "Auto-accept file edits; other gated tools still ask.",
  },
  { key: "plan", label: "Plan", description: "Research and plan only — no tool execution." },
  { key: "auto", label: "Auto", description: "Auto-approve safe actions; ask only for risky ones." },
];

export const DEFAULT_PERMISSION_MODE: PermissionModeKey = "default";

/** Validates a raw persisted string (localStorage/SecureStore/etc.) against the known modes, falling back to the default. */
export function resolvePermissionMode(raw: string | null | undefined): PermissionModeKey {
  return PERMISSION_MODES.some((m) => m.key === raw) ? (raw as PermissionModeKey) : DEFAULT_PERMISSION_MODE;
}
