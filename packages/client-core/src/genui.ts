import { z } from "zod";

/**
 * Generative UI: small interactive pieces an agent can put in a reply.
 *
 * The agent writes a fenced block tagged `renki-ui` holding one JSON object:
 *
 *     ```renki-ui
 *     {"type": "choices", "question": "Which style?", "options": ["Calm", "Punchy"]}
 *     ```
 *
 * The web app draws it as a component (buttons, a checklist, number tiles).
 * Everywhere else (the phone app, copied text) it becomes plain Markdown via
 * `uiFallbackMarkdown`, so no client ever shows the raw JSON. A block that
 * doesn't parse stays an ordinary code block, so a mistake is still readable.
 */

/** The fence info string that marks a block. */
export const UI_FENCE_LANG = "renki-ui";

const text = z.string().trim().min(1).max(500);
/** A plain string is shorthand for `{label: string}` / `{text: string}`, which is what agents tend to write. */
const option = z.union([
  text.transform((label) => ({ label, detail: undefined, reply: undefined })),
  z.object({ label: text, detail: text.optional(), reply: text.optional() }),
]);
const checkItem = z.union([
  text.transform((t) => ({ text: t, done: false, detail: undefined })),
  z.object({ text: text, done: z.boolean().optional().default(false), detail: text.optional() }),
]);
const stat = z.object({ label: text, value: z.union([text, z.number().transform(String)]), note: text.optional() });

const schema = z.discriminatedUnion("type", [
  /** A question with options to pick from. Picking one sends its `reply` (or label) as the user's message. */
  z.object({ type: z.literal("choices"), question: text.optional(), options: z.array(option).min(1).max(8) }),
  /** A list of steps or items, each done or not. */
  z.object({ type: z.literal("checklist"), title: text.optional(), items: z.array(checkItem).min(1).max(30) }),
  /** A few headline numbers side by side. */
  z.object({ type: z.literal("stats"), title: text.optional(), items: z.array(stat).min(1).max(8) }),
]);

export type UiBlock = z.output<typeof schema>;
export type UiChoices = Extract<UiBlock, { type: "choices" }>;
export type UiChecklist = Extract<UiBlock, { type: "checklist" }>;
export type UiStats = Extract<UiBlock, { type: "stats" }>;

/** A block's JSON source as a component description, or null if it isn't valid. */
export function parseUiBlock(source: string): UiBlock | null {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return null;
  }
  const result = schema.safeParse(json);
  return result.success ? result.data : null;
}

/** True when a fence's info string (```renki-ui) marks a UI block. */
export function isUiFence(info: string | null | undefined): boolean {
  return (info ?? "").trim().split(/\s+/)[0] === UI_FENCE_LANG;
}

/** What a choice sends when picked. */
export function choiceReply(o: UiChoices["options"][number]): string {
  return o.reply ?? o.label;
}

/** A block as Markdown, for clients that can't draw it. */
export function uiBlockToMarkdown(block: UiBlock): string {
  switch (block.type) {
    case "choices": {
      const head = block.question ? `**${block.question}**\n\n` : "";
      return head + block.options.map((o, i) => `${i + 1}. ${o.label}${o.detail ? `: ${o.detail}` : ""}`).join("\n");
    }
    case "checklist": {
      const head = block.title ? `**${block.title}**\n\n` : "";
      return head + block.items.map((it) => `- ${it.done ? "✓" : "○"} ${it.text}${it.detail ? `: ${it.detail}` : ""}`).join("\n");
    }
    case "stats": {
      const head = block.title ? `**${block.title}**\n\n` : "";
      return head + block.items.map((s) => `- ${s.label}: **${s.value}**${s.note ? ` (${s.note})` : ""}`).join("\n");
    }
  }
}

/**
 * A reply with every `renki-ui` block swapped for its Markdown version.
 *
 * A block still being written (no closing fence yet, mid-stream) is left out
 * rather than shown as half a JSON object. One that is closed but invalid is
 * kept as the code block it is.
 */
export function uiFallbackMarkdown(md: string): string {
  if (!md.includes(UI_FENCE_LANG)) return md;
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^( {0,3})(`{3,}|~{3,})\s*(.*)$/.exec(lines[i]!);
    if (!open || !isUiFence(open[3])) {
      out.push(lines[i]!);
      continue;
    }
    const fence = open[2]!;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]!);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
        end = j;
        break;
      }
    }
    if (end === -1) break; // unfinished: drop it and everything after (only the block itself can follow)
    const block = parseUiBlock(lines.slice(i + 1, end).join("\n"));
    if (block) out.push(uiBlockToMarkdown(block));
    else out.push(...lines.slice(i, end + 1));
    i = end;
  }
  return out.join("\n");
}
