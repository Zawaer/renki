import {
  type BlockView,
  type ConversationState,
  type TimelineItem,
  type TurnView,
  describeTool,
  formatCost,
  formatTokenCount,
  formatTurnDuration,
  turnTriggerLabel,
} from "@renki/client-core";
import type { AttachmentView, ExportOptions } from "@renki/protocol";

/**
 * A chat as Markdown — the transcript as the apps show it, folded by the same
 * reducer, written for a person to read (or to paste into another chat).
 *
 * Pure: media goes through `media`, which decides how an attachment is
 * referenced — a file in the export's media/ folder, a data URI for a PDF, or
 * null to mention it by name only. Timestamps are always in, in `timeZone`.
 */
export type MediaRef = (attachment: AttachmentView) => string | null;

export type ExportMeta = {
  title: string;
  repoName: string | null;
  branch: string | null;
  createdAt: number;
  exportedAt: number;
};

/** Longest tool output kept in an export; past this it's cut with a note. */
const MAX_TOOL_OUTPUT = 4000;

export function renderMarkdown(
  conv: ConversationState,
  meta: ExportMeta,
  opts: Pick<ExportOptions, "media" | "tools" | "thinking" | "stats">,
  timeZone: string,
  media: MediaRef,
): string {
  const time = (ms: number) => formatWhen(ms, timeZone);
  const out: string[] = [];
  out.push(`# ${meta.title}`, "");
  const where = [meta.repoName, meta.branch].filter(Boolean).join(" · ");
  out.push(`_${where ? `${where} · ` : ""}started ${time(meta.createdAt)} · exported ${time(meta.exportedAt)}_`, "");

  const attachmentLines = (list: AttachmentView[] | undefined): string[] =>
    (list ?? []).map((a) => {
      const ref = opts.media ? media(a) : null;
      if (!ref) return `_Attached: ${a.name}_`;
      return a.mediaType.startsWith("image/") ? `![${escapeAlt(a.name)}](${ref})` : `[${a.name}](${ref})`;
    });

  for (const item of conv.timeline) {
    const section = renderItem(item);
    if (section.length) out.push("---", "", ...section, "");
  }
  return `${out.join("\n").trimEnd()}\n`;

  function renderItem(item: TimelineItem): string[] {
    switch (item.type) {
      case "prompt":
        return [heading("You", item.at), "", ...body(item.text), ...withGap(attachmentLines(item.attachments))];
      case "turn":
        return renderTurn(item.turn);
      case "notice":
        return [`> _${item.at ? `${time(item.at)} · ` : ""}${item.text}_`];
      case "model_change":
        return [`> _Model changed to ${item.model ?? "the default"}._`];
      case "background_tasks":
        return opts.tools ? item.tasks.map((t) => `> _Background task ${t.status}: ${firstLine(t.summary)}_`) : [];
    }
  }

  function renderTurn(turn: TurnView): string[] {
    const lines: string[] = [heading("Claude", turnTime(turn))];
    const label = turnTriggerLabel(turn);
    if (label) lines.push(`_${label}_`);
    const steeredAfter = (i: number) =>
      turn.steeredPrompts
        .filter((p) => p.afterBlockIndex === i)
        .flatMap((p) => ["", heading("You (while Claude was working)", p.at), "", ...body(p.text), ...withGap(attachmentLines(p.attachments))]);

    lines.push(...steeredAfter(-1));
    turn.blocks.forEach((block, i) => {
      if (block) lines.push(...renderBlock(block));
      lines.push(...steeredAfter(i));
    });

    if (turn.status === "error") lines.push("", turn.interrupted ? "_Stopped._" : `_Failed: ${turn.errorMessage ?? "unknown error"}_`);
    if (opts.stats && turn.status === "done") {
      const parts = [
        turn.durationMs != null ? formatTurnDuration(turn.durationMs) : null,
        turn.inputTokens != null || turn.outputTokens != null
          ? `${formatTokenCount((turn.inputTokens ?? 0) + (turn.cachedInputTokens ?? 0) + (turn.outputTokens ?? 0))} tokens`
          : null,
        turn.costUsd != null ? formatCost(turn.costUsd) : null,
      ].filter(Boolean);
      if (parts.length) lines.push("", `_${parts.join(" · ")}_`);
    }
    return lines;
  }

  function renderBlock(block: BlockView): string[] {
    if (block.kind === "text") return block.text.trim() ? ["", block.text.trim()] : [];
    if (block.kind === "thinking") {
      if (!opts.thinking || !block.text.trim()) return [];
      return ["", ...quote(`**Thinking**\n\n${block.text.trim()}`)];
    }
    if (block.kind !== "tool_use") return [];
    const images = opts.media ? (block.result?.images ?? []).flatMap((img) => {
      const ref = media(img);
      return ref ? [`![${escapeAlt(img.name)}](${ref})`] : [];
    }) : [];
    if (!opts.tools) return withGap(images);

    const { label, meta } = describeTool(block.toolName, block.toolInput);
    const lines = ["", `**${label}**${meta ? ` — ${inlineCode(meta)}` : ""}${block.result && !block.result.ok ? " _(failed)_" : ""}`];
    const command = block.toolName === "Bash" ? stringField(block.toolInput, "command") : null;
    if (command) lines.push("", fence(command, "sh"));
    const sub = (block.subagent?.blocks ?? []).flatMap((b) => (b && b.kind === "text" && b.text.trim() ? [b.text.trim()] : []));
    if (sub.length) lines.push("", ...quote(sub.join("\n\n")));
    const output = block.backgroundTask?.summary ?? block.result?.summary;
    if (output?.trim()) lines.push("", fence(truncate(output.trim())));
    return [...lines, ...withGap(images)];
  }

  function heading(who: string, at: number | undefined | null): string {
    return `### ${who}${at ? ` · ${time(at)}` : ""}`;
  }
}

/** When a reply happened: its first block with a time, else none. */
function turnTime(turn: TurnView): number | null {
  for (const b of turn.blocks) {
    if (!b) continue;
    const t = b.kind === "tool_use" ? b.startedAtMs : (b.startedAtMs ?? b.endedAtMs);
    if (t) return t;
  }
  return null;
}

/** "Tue, 7 Oct 2026, 14:05" in the exporting device's zone. */
export function formatWhen(ms: number, timeZone: string): string {
  try {
    return new Date(ms).toLocaleString("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

function body(text: string): string[] {
  return text.trim() ? [text.trim()] : [];
}

function withGap(lines: string[]): string[] {
  return lines.length ? ["", ...lines] : [];
}

function quote(text: string): string[] {
  return text.split("\n").map((l) => (l ? `> ${l}` : ">"));
}

/** A fenced block that can't be closed early by backticks inside it. */
function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function inlineCode(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (${text.length - MAX_TOOL_OUTPUT} more characters)` : text;
}

function firstLine(text: string): string {
  return text.split("\n")[0]!.slice(0, 200);
}

function escapeAlt(name: string): string {
  return name.replace(/[[\]]/g, "");
}

function stringField(input: unknown, key: string): string | null {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && v.trim() ? v : null;
}
