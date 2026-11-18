import { tool, type HookCallbackMatcher, type HookJSONOutput, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { attentionReason } from "@renki/client-core";
import type { Session } from "@renki/protocol";
import { z } from "zod";

/**
 * The overview chat's own tools: one standing chat that knows about all the
 * others (see sessions/overview.ts). list_chats reads the roster; start_chat
 * and send_to_chat act in the user's name, so they always ask first, even in
 * Auto or bypass mode. Reading a chat's content is read_chat / search_chats
 * (chatTools.ts), which every chat has.
 */

export const LIST_CHATS_TOOL = "mcp__renki__list_chats";
export const START_CHAT_TOOL = "mcp__renki__start_chat";
export const SEND_TO_CHAT_TOOL = "mcp__renki__send_to_chat";

export type OverviewToolDeps = {
  currentId: string;
  listSessions: () => Session[];
  /** The newest message the user sent in a chat, if any. */
  lastPrompt: (id: string) => { text: string; ts: number } | null;
  repos: () => Promise<{ id: string; name: string }[]>;
  /** Start a chat (in a repo, or none) and send it `prompt`. Resolves once it has been sent. */
  startChat: (input: { repo: string | null; prompt: string; title?: string }) => Promise<{ id: string; title: string }>;
  /** Send `text` to chat `id` as the user would: runs now, joins the turn in progress, or queues. */
  sendToChat: (id: string, text: string) => Promise<"started" | "steered" | "queued">;
  timeZone: () => string;
};

const REASON_TEXT: Record<string, string> = {
  permission: "WAITING ON YOU: an approval is pending",
  error: "stopped with an error",
  paused: "paused on a usage limit, will continue by itself",
  unpushed: "has work not pushed to GitHub",
};

function ago(ms: number, now: number): string {
  const m = Math.round((now - ms) / 60_000);
  if (m < 60) return `${Math.max(m, 0)}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

/** The roster as Claude reads it: one entry per chat, what needs the user first. */
export function describeChats(deps: Pick<OverviewToolDeps, "currentId" | "listSessions" | "lastPrompt">, opts: { includeArchived: boolean; limit: number }, now = Date.now()): string {
  const chats = deps
    .listSessions()
    .filter((s) => s.id !== deps.currentId && s.status !== "trashed" && s.status !== "deleted" && (opts.includeArchived || s.status !== "archived"))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  if (!chats.length) return "No other chats.";
  const shown = chats.slice(0, opts.limit);
  const lines = shown.map((s) => {
    const why = attentionReason(s);
    const state = [s.status === "busy" ? "working now" : s.status, why ? REASON_TEXT[why] : null, s.unpushed && why !== "unpushed" ? "unpushed work" : null].filter(Boolean).join("; ");
    const last = deps.lastPrompt(s.id);
    return [
      `- [@${oneLine(s.title?.trim() || "Untitled chat", 80)}](renki://chat/${s.id}) — ${s.repoId ? s.repoName : "no repo"}, ${state}, active ${ago(s.lastActivityAt, now)}`,
      last ? `    last asked: "${oneLine(last.text, 160)}"` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const waiting = chats.filter((s) => attentionReason(s) === "permission").length;
  const busy = chats.filter((s) => s.status === "busy").length;
  return [
    `${chats.length} chats${opts.includeArchived ? "" : " (archived left out)"}: ${busy} working now, ${waiting} waiting on the user.${chats.length > shown.length ? ` Showing the ${shown.length} most recent.` : ""}`,
    ...lines,
  ].join("\n");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createOverviewTools(deps: OverviewToolDeps): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "list_chats",
      "Every one of the user's Renki chats as it is right now: title (as a chat link), repo, whether it's working, waiting on the user (approval pending, error, paused), has unpushed work, how long ago it was active, and the last thing the user asked in it. Newest first. " +
        "Call it whenever the user asks what's going on; don't rely on an earlier call, the state changes.",
      { includeArchived: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() },
      async ({ includeArchived, limit }) => text(describeChats(deps, { includeArchived: includeArchived ?? false, limit: limit ?? 40 })),
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      "start_chat",
      "Start a new Renki chat and send it its first message, as the user would. `repo` is a repo name or id from Renki (omit for a chat without a repo); `prompt` is the full brief: the new chat knows nothing of this one, so say everything it needs. The user approves it first. Returns the new chat's link.",
      { repo: z.string().trim().min(1).max(200).optional(), prompt: z.string().trim().min(1).max(20_000), title: z.string().trim().min(1).max(80).optional() },
      async ({ repo, prompt, title }) => {
        try {
          let repoId: string | null = null;
          if (repo) {
            const all = await deps.repos();
            const want = repo.toLowerCase().replace(/^.*\//, "");
            const hit = all.find((r) => r.id.toLowerCase() === want || r.name.toLowerCase() === want);
            if (!hit) return text(`No repo "${repo}" in Renki. Repos: ${all.map((r) => r.name).join(", ")}.`, true);
            repoId = hit.id;
          }
          const chat = await deps.startChat({ repo: repoId, prompt, ...(title ? { title } : {}) });
          return text(`Started [@${chat.title}](renki://chat/${chat.id}) and sent it the brief. It's working on it now.`);
        } catch (err) {
          return text(`Couldn't start the chat: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    ),
    tool(
      "send_to_chat",
      "Send a message to another of the user's Renki chats, as the user would: it starts a turn there, joins the turn in progress, or queues behind it. `chat` is its id or link. The message shows in that chat as sent from the overview. The user approves it first.",
      { chat: z.string().trim().min(1).max(300), message: z.string().trim().min(1).max(20_000) },
      async ({ chat, message }) => {
        const id = /s_[A-Za-z0-9_-]{4,64}/.exec(chat)?.[0];
        if (!id) return text("`chat` must be a chat id (s_…) or a chat link.", true);
        if (id === deps.currentId) return text("That's this chat.", true);
        try {
          const how = await deps.sendToChat(id, message);
          const s = deps.listSessions().find((x) => x.id === id);
          const link = `[@${s?.title?.trim() || "the chat"}](renki://chat/${id})`;
          return text(how === "started" ? `Sent to ${link}; it's working on it.` : how === "steered" ? `Sent to ${link}, into the turn it was already running.` : `Queued in ${link} behind what it's doing.`);
        } catch (err) {
          return text(`Couldn't send: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    ),
  ];
}

/** start_chat and send_to_chat act in the user's name: always ask, whatever the permission mode. */
export function createOverviewApprovalHook(): HookCallbackMatcher {
  return {
    matcher: `${START_CHAT_TOOL}|${SEND_TO_CHAT_TOOL}`,
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse" || (input.tool_name !== START_CHAT_TOOL && input.tool_name !== SEND_TO_CHAT_TOOL)) return { continue: true };
        const i = (input.tool_input ?? {}) as { repo?: string; prompt?: string; chat?: string; message?: string };
        const reason =
          input.tool_name === START_CHAT_TOOL
            ? `Start a new chat${i.repo ? ` in ${i.repo}` : ""}: "${oneLine(i.prompt ?? "", 200)}"`
            : `Send to ${i.chat ?? "a chat"}: "${oneLine(i.message ?? "", 200)}"`;
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } };
      },
    ],
  };
}
