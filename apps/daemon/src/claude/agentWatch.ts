/**
 * What each running subagent has been doing lately, for the main agent.
 *
 * Claude Code tells the main agent only that a background agent started and,
 * later, what it returned. Everything in between reaches Renki (it fills the
 * agent's row in the UI) but never the model, so "how's that agent doing?"
 * got answered by guessing from side effects on disk. AgentWatch keeps the
 * last few steps of every live agent so the daemon can attach them to the
 * user's next message, along with where the agent's full transcript is.
 */

/** How many of an agent's latest steps go into the note. */
const STEPS_KEPT = 6;
/** A step's text is cut to this many characters; the transcript has the rest. */
const STEP_CHARS = 160;

type Step = { at: number; text: string };

type WatchedAgent = {
  taskId: string;
  description: string;
  startedAt: number;
  steps: Step[];
  toolUses: number | null;
};

/** One line for a step: the agent's words, or the tool it called and on what. */
function describeBlock(block: { type?: string; text?: string; name?: string; input?: unknown }): string | null {
  if (block.type === "text" && block.text?.trim()) return `said: ${block.text.trim()}`;
  if (block.type !== "tool_use" || !block.name) return null;
  const input = (block.input ?? {}) as Record<string, unknown>;
  const detail = ["description", "command", "file_path", "pattern", "url", "prompt"]
    .map((k) => input[k])
    .find((v): v is string => typeof v === "string" && v.trim() !== "");
  return detail ? `${block.name}: ${detail.trim()}` : block.name;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > STEP_CHARS ? `${flat.slice(0, STEP_CHARS - 1)}…` : flat;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export class AgentWatch {
  /** tool_use id of the Agent call -> what it's been doing. */
  private readonly agents = new Map<string, WatchedAgent>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A task started. Only subagents are watched: background shells and the like have no steps to tell. */
  started(msg: { task_id: string; tool_use_id?: string; description?: string; task_type?: string; subagent_type?: string }): void {
    if (!msg.tool_use_id) return;
    const isAgent = msg.task_type === "local_agent" || msg.subagent_type !== undefined || msg.task_type === undefined;
    if (!isAgent) return;
    this.agents.set(msg.tool_use_id, { taskId: msg.task_id, description: msg.description ?? "", startedAt: this.now(), steps: [], toolUses: null });
  }

  /** One of a subagent's whole messages, forwarded with its Agent call's id as parent. */
  message(parentToolUseId: string, content: unknown): void {
    const agent = this.agents.get(parentToolUseId);
    if (!agent || !Array.isArray(content)) return;
    for (const block of content) {
      const text = describeBlock(block as Parameters<typeof describeBlock>[0]);
      if (text) agent.steps.push({ at: this.now(), text: clip(text) });
    }
    if (agent.steps.length > STEPS_KEPT) agent.steps.splice(0, agent.steps.length - STEPS_KEPT);
  }

  progress(toolUseId: string, toolUses: number): void {
    const agent = this.agents.get(toolUseId);
    if (agent) agent.toolUses = toolUses;
  }

  finished(taskId: string): void {
    for (const [id, agent] of this.agents) if (agent.taskId === taskId) this.agents.delete(id);
  }

  clear(): void {
    this.agents.clear();
  }

  /**
   * The note for the main agent, or null with no agent running.
   * `transcriptDir` is the folder holding the agents' transcripts
   * (agent-<task id>.jsonl), when the conversation has one yet.
   */
  note(transcriptDir: string | null): string | null {
    if (this.agents.size === 0) return null;
    const now = this.now();
    const lines = ["[From Renki, not the user: what your running agents are doing right now, from their own transcripts.]"];
    for (const agent of this.agents.values()) {
      const facts = [`running ${duration(now - agent.startedAt)}`];
      if (agent.toolUses !== null) facts.push(`${agent.toolUses} tool calls`);
      lines.push(`Agent "${agent.description || agent.taskId}" (${facts.join(", ")}):`);
      if (agent.steps.length === 0) lines.push("- no steps yet");
      for (const step of agent.steps) lines.push(`- ${duration(now - step.at)} ago, ${step.text}`);
      if (transcriptDir) lines.push(`Full transcript: ${transcriptDir}/agent-${agent.taskId}.jsonl`);
    }
    return lines.join("\n");
  }
}
