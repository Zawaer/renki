import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionMode, PermissionResult, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, CapabilitiesResponse, EventPayload } from "@crc/protocol";
import { newTurnId } from "../ids.js";
import { logger } from "../logger.js";
import { createRtkPreToolUseHook } from "./rtk.js";
import {
  type BlockTracking,
  type PermissionResolver,
  type RunTurnResult,
  buildUserMessage,
  classifyRateLimit,
  handleAssistantMessage,
  handleStreamEvent,
  handleToolResults,
  isInterruptedTerminalReason,
  summarizeResultError,
} from "./runner.js";
import { stripUntrustedHooks } from "./settingsHygiene.js";

/**
 * One long-lived `claude` process for one CRC session.
 *
 * The SDK's `query()` is fed an input stream that never ends on its own
 * (`InputChannel`), so the child's stdin stays open across turns. That is the
 * whole point: the SDK only calls `transport.endInput()` once the input
 * iterable completes, and a closed stdin makes the CLI reject every later
 * `can_use_tool` request — including the ones a background subagent makes
 * after the turn that spawned it has already returned its `result`
 * (anthropics/claude-agent-sdk-typescript#376). With the stream held open,
 * background agents keep running between turns, their permission prompts keep
 * reaching the controller, and their completion notifications arrive whenever
 * they happen, even while the session is otherwise idle.
 *
 * Turns are still strictly serialized by the caller (SessionManager): exactly
 * one prompt is in flight at a time, so a `result` message always belongs to
 * the in-flight prompt (cross-checked against the SDK's `user_message_uuid`).
 * The one exception is an "auto turn" — the CLI starting a turn on its own,
 * e.g. the main agent reacting to a background task finishing. Those get a
 * synthetic promptId and are reported through `onAutoTurnStart/End` so the
 * manager can flip the session busy for their duration.
 *
 * "Steering": a prompt pushed while a turn is in flight (`steer()`) is NOT a
 * new turn. The CLI picks it up at its next tool-call boundary and answers it
 * within the running turn, which then ends with a single `result` — verified
 * against the real CLI. So steered prompts are tracked on the in-flight turn
 * and reported in its turn_result's `promptIds`. (The CLI neither echoes the
 * pushed message back nor sets `result.user_message_uuid` to anything we sent,
 * so there is no per-message acknowledgement to key off.)
 *
 * Crash/restart recovery is unchanged from the resume-per-prompt days: the
 * conversation lives in the CLI's resumable transcript (`claudeSessionId`),
 * so a dead process is simply replaced by a fresh one that resumes it.
 */

export type LiveSessionOptions = {
  cwd: string;
  /** Prior Claude session id to resume, or null to start a fresh conversation. */
  resumeSessionId: string | null;
  /** Append an event to the session's log (the live session's only output channel). */
  emit: (payload: EventPayload) => void;
  /** Initial per-turn knobs; later turns that differ are applied via control requests before their prompt is sent. */
  model?: string;
  permissionMode?: PermissionMode;
  maxThinkingTokens?: number | null;
  /** If true, don't load ~/.claude settings so every gated tool asks the controller. */
  forcePermissionPrompts?: boolean;
  /** If true, rewrite Bash commands through RTK (see ./rtk.ts) before they run. */
  enableRtk?: boolean;
  /** `rtk` executable to invoke when enableRtk is set (name on PATH or absolute path). */
  rtkBin?: string;
  /** Only obtainable from a live Query object — the caller opts in when it doesn't already have this cached daemon-wide. */
  onCapabilities?: (caps: CapabilitiesResponse) => void;
  /** The CLI began a turn nobody prompted (see class doc). The caller should treat the session as busy until `onAutoTurnEnd`. */
  onAutoTurnStart?: (turnId: string, promptId: string) => void;
  onAutoTurnEnd?: (result: RunTurnResult) => void;
  /** Fired exactly once, when the underlying process is gone for good (crash, exit, or `close()`). */
  onClosed?: (reason: string) => void;
};

/** A prompt delivered into the turn that's already running — see LiveClaudeSession.steer. */
export type SteerArgs = {
  prompt: string;
  attachments?: Attachment[];
  promptId: string;
};

export type LiveTurnArgs = {
  prompt: string;
  /** Images/PDFs/text files attached to this prompt, if any — see buildUserMessage. */
  attachments?: Attachment[];
  promptId: string;
  resolvePermission: PermissionResolver;
  model?: string;
  /** Which kind of client submitted this prompt ("web"/"phone"/"vscode"), stamped onto the resulting turn_result for stats. */
  clientType?: string;
  /** Thinking-token budget; omit/null for the SDK's own default. */
  maxThinkingTokens?: number | null;
  /** SDK permission mode; omit for `"default"` (ask for every gated tool). */
  permissionMode?: PermissionMode;
};

type InflightTurn = {
  turnId: string;
  promptId: string;
  /** The uuid we stamped on the user message, so the matching `result.user_message_uuid` can be cross-checked. */
  uuid: string;
  model: string | null;
  clientType: string | null;
  sawRateLimitError: boolean;
  resolve: (r: RunTurnResult) => void;
};

/**
 * A push-based async iterable: `push()` hands a message to whoever is
 * awaiting the iterator, `close()` ends it. The SDK pulls from this as the
 * query's `prompt`; because it only completes on `close()`, the SDK never
 * closes the child's stdin behind our back.
 */
export class InputChannel implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("InputChannel is closed");
    this.queue.push(message);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null;
          resolve();
        };
      });
    }
  }
}

/** Injectable for tests: anything that looks enough like the SDK's `query()` to drive the message loop. */
export type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export class LiveClaudeSession {
  private readonly channel = new InputChannel();
  private readonly q: Query;
  private inflight: InflightTurn | null = null;
  private autoTurn: { turnId: string; promptId: string } | null = null;
  /** Prompts steered into the current turn, in delivery order — reported in its turn_result.promptIds. */
  private steered: string[] = [];
  /** A background task finished since the last `result` — makes the next unprompted turn a "background_task" one, not a mystery. */
  private taskFinishedSinceResult = false;
  /** Resolvers waiting for the current auto turn to settle (see runTurn). */
  private autoTurnWaiters: Array<() => void> = [];
  private resolver: PermissionResolver | null = null;
  /**
   * tool_use id -> the turn it was emitted in. A background subagent's forwarded
   * text (and its tool results) arrive tagged only with the Task call's
   * tool_use id as `parent_tool_use_id`, possibly turns later — this is how
   * those events find their way back to the turn whose transcript actually
   * holds that Task block, which is where clients render them.
   */
  private readonly toolUseTurn = new Map<string, string>();
  /**
   * Anthropic's raw stream numbers content blocks PER underlying model call —
   * a tool round-trip starts a brand-new message whose own blocks count from
   * 0 again. Each (sub)agent gets its OWN tracking, keyed by parent_tool_use_id
   * (`""` for the main agent): a subagent's forwarded messages (see
   * forwardSubagentText below) are a completely separate block-index space
   * from the main turn's, arriving interleaved with it — sharing one tracker
   * between them would corrupt the main turn's offsets with the subagent's
   * block count and vice versa. The main agent's tracker resets per turn
   * (block indices are per turn); subagent trackers live as long as the agent.
   */
  private readonly agentTracking = new Map<string, BlockTracking>();
  /** Live background tasks as last reported by the CLI (REPLACE semantics on background_tasks_changed). */
  private backgroundTasks = new Set<string>();
  private lastTurnId: string | null = null;
  /**
   * The SDK's `total_cost_usd` is cumulative for the life of the process, not
   * the cost of one turn. Under resume-per-prompt that was the same thing —
   * every turn got a fresh process — but with one long-lived process per
   * session it climbs forever, so each turn's own cost is the delta.
   */
  private costUsdSoFar = 0;
  private currentModel: string | undefined;
  private currentPermissionMode: PermissionMode;
  private currentMaxThinkingTokens: number | null | undefined;
  private closed = false;
  private _claudeSessionId: string | null;
  private _lastActivityAt = Date.now();

  constructor(
    private readonly opts: LiveSessionOptions,
    queryFactory: QueryFactory = query as QueryFactory,
  ) {
    this._claudeSessionId = opts.resumeSessionId;
    this.currentModel = opts.model;
    this.currentPermissionMode = opts.permissionMode ?? "default";
    this.currentMaxThinkingTokens = opts.maxThinkingTokens;

    // Repo-defined hooks run unconditionally regardless of settingSources or
    // canUseTool — see settingsHygiene.ts for why this runs before every spawn.
    stripUntrustedHooks(opts.cwd);

    const options: Options = {
      cwd: opts.cwd,
      includePartialMessages: true,
      permissionMode: this.currentPermissionMode,
      // Forward a subagent's own thinking/text as it happens (not just its
      // final tool_result) so the UI can render a live nested transcript
      // instead of a black-box spinner for the whole Task call.
      forwardSubagentText: true,
      ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxThinkingTokens != null ? { maxThinkingTokens: opts.maxThinkingTokens } : {}),
      ...(opts.forcePermissionPrompts ? { settingSources: [] } : {}),
      ...(opts.enableRtk ? { hooks: { PreToolUse: [createRtkPreToolUseHook(opts.rtkBin ?? "rtk")] } } : {}),
      // Route every permission decision through the current resolver. Only
      // fires for tools the permission system doesn't auto-resolve (edits,
      // bash, etc.) — exactly the set a human controller should see. Also
      // fires between turns, for background subagents; that's the case the
      // old resume-per-prompt design could never serve.
      canUseTool: (toolName, input, o) => this.onPermission(toolName, input, o.toolUseID, o.signal),
      // Surface the child process's stderr into our logs for debuggability.
      stderr: (data: string) => logger.debug("claude stderr", { data: data.slice(0, 500) }),
    };

    this.q = queryFactory({ prompt: this.channel, options });

    // supportedModels()/supportedCommands() only exist on a LIVE Query object,
    // so this is the one place we can ever discover them. Best-effort and
    // concurrent with the message loop (a separate control-request channel).
    if (opts.onCapabilities) {
      const onCapabilities = opts.onCapabilities;
      Promise.all([this.q.supportedModels(), this.q.supportedCommands()])
        .then(([models, commands]) => onCapabilities({ models, commands }))
        .catch((err) => logger.warn("supportedModels/supportedCommands failed", { err: String(err) }));
    }

    void this.consume();
  }

  /** The Claude session id to persist for the next resume (may have been freshly minted by this process). */
  get claudeSessionId(): string | null {
    return this._claudeSessionId;
  }

  /** True while any turn — prompted or auto — is in flight. */
  get busy(): boolean {
    return this.inflight !== null || this.autoTurn !== null;
  }

  /** Background Agent-tool tasks the CLI still reports as running. */
  get backgroundTaskCount(): number {
    return this.backgroundTasks.size;
  }

  /** Last time any message crossed the wire in either direction. */
  get lastActivityAt(): number {
    return this._lastActivityAt;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Send one prompt and resolve when its turn ends (its `result` arrived, the
   * process died, or the session was closed). Never rejects: failures come
   * back as `ok: false` results, exactly like the old one-shot runner, and the
   * matching `turn_result` event has already been emitted by the time this
   * resolves. The caller must not have another turn in flight.
   */
  async runTurn(args: LiveTurnArgs): Promise<RunTurnResult> {
    if (this.closed) return this.failedResult("Live session is closed.", false);
    if (this.inflight) throw new Error("LiveClaudeSession: a turn is already in flight");

    this.resolver = args.resolvePermission;
    await this.applyKnobs(args);
    // If the CLI started a turn of its own while we were applying knobs, let it
    // finish first — pushing now would make the CLI coalesce our prompt into
    // that turn and hand back a single `result` for both.
    while (this.autoTurn && !this.closed) await new Promise<void>((resolve) => this.autoTurnWaiters.push(resolve));
    if (this.closed) return this.failedResult("Live session is closed.", false);

    const turnId = newTurnId();
    this.agentTracking.delete("");
    this.lastTurnId = turnId;
    const uuid = randomUUID();

    return new Promise<RunTurnResult>((resolve) => {
      this.inflight = {
        turnId,
        promptId: args.promptId,
        uuid,
        model: args.model ?? null,
        clientType: args.clientType ?? null,
        sawRateLimitError: false,
        resolve,
      };
      this._lastActivityAt = Date.now();
      this.opts.emit({ kind: "turn_started", turnId, promptId: args.promptId, trigger: "prompt" });
      try {
        // `uuid` is our handle for cross-checking `result.user_message_uuid`
        // and for reading `interrupt()`'s still_queued receipt.
        this.channel.push({ ...buildUserMessage(args.prompt, args.attachments), uuid: uuid as SDKUserMessage["uuid"] });
      } catch (err) {
        this.settleInflight(this.failedResult(err instanceof Error ? err.message : String(err), false), true);
      }
    });
  }

  /**
   * Deliver a prompt into the turn that is running right now. The CLI reads it
   * at its next tool-call boundary and folds the answer into the same turn —
   * this is what lets "also do X in a background agent" start while a long
   * task is mid-flight instead of waiting behind it. Throws if no turn is in
   * flight (the caller should run it as an ordinary turn instead). Per-turn
   * knobs (model, permission mode) can't change mid-turn and are not accepted.
   */
  steer(args: SteerArgs): void {
    if (this.closed) throw new Error("LiveClaudeSession: closed");
    if (!this.busy) throw new Error("LiveClaudeSession: no turn in flight to steer");
    this.channel.push({ ...buildUserMessage(args.prompt, args.attachments), uuid: randomUUID() as SDKUserMessage["uuid"] });
    this.steered.push(args.promptId);
    this._lastActivityAt = Date.now();
  }

  /**
   * Ask the CLI how full the context window is and record it. Best-effort and
   * fire-and-forget: it costs a control round-trip, so it runs once a turn has
   * settled rather than during one, and a failure is never worth surfacing.
   */
  private reportContextUsage(): void {
    if (this.closed || typeof this.q.getContextUsage !== "function") return;
    void Promise.resolve()
      .then(() => this.q.getContextUsage())
      .then((usage) => {
        if (this.closed || !usage || !usage.maxTokens) return;
        this.opts.emit({
          kind: "context_usage",
          usedTokens: Math.max(0, Math.round(usage.totalTokens)),
          maxTokens: Math.round(usage.maxTokens),
          percentage: Math.max(0, Math.min(100, usage.percentage)),
          autoCompact: usage.isAutoCompactEnabled,
        });
      })
      .catch((err) => logger.debug("getContextUsage failed", { err: String(err) }));
  }

  /** Stop the in-flight turn (the "stop" button). The turn still ends through the normal `result` path, just early. */
  async interrupt(): Promise<void> {
    if (!this.busy) return;
    await this.q.interrupt();
  }

  /**
   * Push a live permission-mode change. Unlike the old per-turn design this
   * also applies while idle — a background subagent's later tool checks see
   * it — and it doubles as the "current" mode the next prompt compares against.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.closed) return;
    await this.q.setPermissionMode(mode);
    this.currentPermissionMode = mode;
  }

  /** Terminate the child process. Any in-flight turn ends with a failed result. Idempotent. */
  close(reason = "closed"): void {
    if (this.closed) return;
    this.finish(reason);
    try {
      this.q.close();
    } catch (err) {
      logger.debug("live session close threw", { err: String(err) });
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /** Bring the process's model/permission mode/thinking budget in line with what this prompt asked for. */
  private async applyKnobs(args: LiveTurnArgs): Promise<void> {
    const wantedMode = args.permissionMode ?? "default";
    if (wantedMode !== this.currentPermissionMode) {
      await this.q.setPermissionMode(wantedMode).catch((err) => logger.warn("setPermissionMode failed", { err: String(err) }));
      this.currentPermissionMode = wantedMode;
    }
    if (args.model !== this.currentModel) {
      await this.q.setModel(args.model).catch((err) => logger.warn("setModel failed", { err: String(err) }));
      this.currentModel = args.model;
    }
    const wantedThinking = args.maxThinkingTokens ?? null;
    if (wantedThinking !== (this.currentMaxThinkingTokens ?? null)) {
      await this.q
        .setMaxThinkingTokens(wantedThinking)
        .catch((err) => logger.warn("setMaxThinkingTokens failed", { err: String(err) }));
      this.currentMaxThinkingTokens = wantedThinking;
    }
  }

  private async onPermission(
    toolName: string,
    input: Record<string, unknown>,
    toolUseID: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const requestId = toolUseID;
    // The tool_use block this request is for has normally already been emitted
    // (the assistant message precedes the permission check), so a background
    // subagent's request between turns still lands on the turn whose
    // transcript holds its Task block. Fall back to the current/most recent
    // turn only if the block was never seen.
    const turnId = this.toolUseTurn.get(toolUseID) ?? this.inflight?.turnId ?? this.autoTurn?.turnId ?? this.lastTurnId ?? "";
    const resolver = this.resolver;
    if (!resolver) return { behavior: "deny", message: "No controller available." };

    this.opts.emit({ kind: "permission_request", requestId, turnId, toolName, toolInput: input });
    const { decision, byDeviceId, updatedInput } = await resolver({ requestId, turnId, toolName, toolInput: input, signal });
    this.opts.emit({ kind: "permission_resolved", requestId, decision, byDeviceId });

    return decision === "allow"
      ? { behavior: "allow", updatedInput: updatedInput ?? input }
      : { behavior: "deny", message: "Denied by controller." };
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.q) {
        this._lastActivityAt = Date.now();
        // Every SDK message carries the session id; keep the latest so we can
        // resume next time even if the id was freshly minted by this process.
        if ("session_id" in message && message.session_id) this._claudeSessionId = message.session_id;
        this.handle(message);
      }
      this.finish("process ended");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("live session loop failed", { cwd: this.opts.cwd, err: msg });
      this.finish(msg);
    }
  }

  private trackingFor(parentToolUseId: string | null): BlockTracking {
    const key = parentToolUseId ?? "";
    let t = this.agentTracking.get(key);
    if (!t) {
      t = { blockKinds: new Map(), globalOffset: 0, startedAt: new Map() };
      this.agentTracking.set(key, t);
    }
    return t;
  }

  /**
   * Which turn an incoming (sub)agent message belongs to. A subagent's
   * messages go to the turn holding its Task block; anything else goes to the
   * in-flight turn — or, if there is none, starts an auto turn.
   */
  private turnFor(parentToolUseId: string | null): string {
    if (parentToolUseId) {
      const owner = this.toolUseTurn.get(parentToolUseId);
      if (owner) return owner;
    }
    if (this.inflight) return this.inflight.turnId;
    if (this.autoTurn) return this.autoTurn.turnId;
    return this.startAutoTurn();
  }

  private startAutoTurn(): string {
    const turnId = newTurnId();
    this.autoTurn = { turnId, promptId: `auto_${turnId}` };
    this.agentTracking.delete("");
    this.lastTurnId = turnId;
    const trigger = this.taskFinishedSinceResult ? "background_task" : "auto";
    logger.info("live session started an unprompted turn", { cwd: this.opts.cwd, turnId, trigger });
    this.opts.onAutoTurnStart?.(turnId, this.autoTurn.promptId);
    this.opts.emit({ kind: "turn_started", turnId, promptId: this.autoTurn.promptId, trigger });
    return turnId;
  }

  private handle(message: SDKMessage): void {
    switch (message.type) {
      case "stream_event": {
        const turnId = this.turnFor(message.parent_tool_use_id);
        const t = this.trackingFor(message.parent_tool_use_id);
        handleStreamEvent(message.event, turnId, t.blockKinds, t.globalOffset, message.parent_tool_use_id, this.opts.emit, t.startedAt);
        break;
      }

      case "assistant": {
        const sdkError = (message as { error?: string }).error;
        if (sdkError === "rate_limit" && this.inflight) this.inflight.sawRateLimitError = true;
        // An SDK-flagged error frame's content is just a placeholder repeating
        // the same failure the `result` message's errorMessage will carry —
        // skip it here so it isn't shown twice.
        if (sdkError) break;
        const turnId = this.turnFor(message.parent_tool_use_id);
        const t = this.trackingFor(message.parent_tool_use_id);
        handleAssistantMessage(
          message.message,
          turnId,
          t.blockKinds,
          t.globalOffset,
          {
            parentToolUseId: message.parent_tool_use_id,
            subagentType: (message as { subagent_type?: string }).subagent_type,
            taskDescription: (message as { task_description?: string }).task_description,
          },
          this.opts.emit,
          t.startedAt,
        );
        // Remember which turn each tool_use call lives in, so a subagent it
        // spawns can be routed back here even turns later (see toolUseTurn).
        const content = (message.message as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const block of content as Array<{ type?: string; id?: string }>) {
            if (block?.type === "tool_use" && block.id) this.toolUseTurn.set(block.id, turnId);
          }
        }
        // This message is done — its local indices are now spoken for. Shift
        // the next message FROM THE SAME (sub)agent past them.
        const maxLocal = t.blockKinds.size > 0 ? Math.max(...t.blockKinds.keys()) : -1;
        t.globalOffset += maxLocal + 1;
        t.blockKinds.clear();
        t.startedAt.clear();
        break;
      }

      case "user": {
        // Replays of our own prompts carry no tool_result blocks and are
        // ignored by handleToolResults; only actual tool results get logged.
        const hasToolResult =
          Array.isArray(message.message.content) &&
          message.message.content.some((b) => (b as { type?: string }).type === "tool_result");
        if (!hasToolResult) break;
        handleToolResults(message.message, this.turnFor(message.parent_tool_use_id), this.opts.emit);
        break;
      }

      case "system": {
        if (message.subtype === "task_notification") {
          // A background Agent-tool task reporting it's done — may arrive during
          // a later turn or while idle, so the event carries no turnId; see
          // background_task's own doc comment in events.ts for why.
          this.backgroundTasks.delete(message.task_id);
          this.taskFinishedSinceResult = true;
          this.opts.emit({
            kind: "background_task",
            taskId: message.task_id,
            toolUseId: message.tool_use_id ?? null,
            status: message.status,
            summary: message.summary,
          });
        } else if (message.subtype === "background_tasks_changed") {
          this.backgroundTasks = new Set(message.tasks.map((t) => t.task_id));
        }
        break;
      }

      case "result": {
        this.endTurn(message);
        break;
      }

      default:
        // init, task_started, task_progress, status, compact_boundary, etc. — not modeled.
        break;
    }
  }

  private endTurn(message: Extract<SDKMessage, { type: "result" }>): void {
    const target = this.inflight ?? this.autoTurn;
    if (!target) {
      logger.debug("result with no turn in flight", { cwd: this.opts.cwd, subtype: message.subtype });
      return;
    }
    const ok = message.subtype === "success" && !message.is_error;
    const cumulativeCost = message.total_cost_usd ?? null;
    const costUsd = cumulativeCost != null ? Math.max(0, cumulativeCost - this.costUsdSoFar) : null;
    if (cumulativeCost != null) this.costUsdSoFar = cumulativeCost;
    const interrupted = !ok && isInterruptedTerminalReason((message as { terminal_reason?: unknown }).terminal_reason);
    const errorMessage = ok ? null : interrupted ? "Stopped by controller." : summarizeResultError(message);
    const usage = (message as {
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    }).usage;
    /**
     * What this turn actually ingested: fresh input plus whatever it wrote to
     * the cache. Cache READS are reported separately — the CLI sums usage over
     * every API call in the turn, so a turn with four tool round-trips re-reads
     * the same context three extra times (measured: 31k ingested, 92k re-read).
     * Folding those in made short turns read as hundreds of thousands of
     * tokens and long sessions as millions.
     */
    const inputTokens = usage == null ? null : (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const cachedInputTokens = usage == null ? null : (usage.cache_read_input_tokens ?? 0);
    const sawRateLimit = this.inflight?.sawRateLimitError ?? false;

    const promptIds = this.takeSteered(target.promptId);
    this.taskFinishedSinceResult = false;
    this.opts.emit({
      kind: "turn_result",
      turnId: target.turnId,
      promptId: target.promptId,
      promptIds,
      ok,
      costUsd,
      durationMs: message.duration_ms ?? null,
      errorMessage,
      inputTokens,
      cachedInputTokens,
      outputTokens: usage?.output_tokens ?? null,
      interrupted,
      model: this.inflight?.model ?? null,
      clientType: this.inflight?.clientType ?? null,
    });

    const result: RunTurnResult = {
      claudeSessionId: this._claudeSessionId,
      ok,
      costUsd,
      durationMs: message.duration_ms ?? null,
      errorMessage,
      rateLimited: !ok && (sawRateLimit || classifyRateLimit(errorMessage)),
      interrupted,
    };

    if (this.inflight) this.settleInflight(result, false);
    else this.settleAutoTurn(result);
    // The conversation only grows at turn boundaries, so this is the moment to look.
    this.reportContextUsage();
  }

  private settleInflight(result: RunTurnResult, emitFailure: boolean): void {
    const turn = this.inflight;
    if (!turn) return;
    this.inflight = null;
    if (emitFailure) {
      this.opts.emit({
        kind: "turn_result",
        turnId: turn.turnId,
        promptId: turn.promptId,
        promptIds: this.takeSteered(turn.promptId),
        ok: false,
        costUsd: null,
        durationMs: null,
        errorMessage: result.errorMessage,
        inputTokens: null,
        outputTokens: null,
        interrupted: false,
        model: turn.model,
        clientType: turn.clientType,
      });
    }
    turn.resolve(result);
  }

  private settleAutoTurn(result: RunTurnResult): void {
    if (!this.autoTurn) return;
    this.autoTurn = null;
    const waiters = this.autoTurnWaiters;
    this.autoTurnWaiters = [];
    this.opts.onAutoTurnEnd?.(result);
    for (const wake of waiters) wake();
  }

  /** The finished turn's full prompt list (representative first, then steered), clearing the steered set. */
  private takeSteered(promptId: string): string[] {
    const ids = [promptId, ...this.steered];
    this.steered = [];
    return ids;
  }

  private failedResult(errorMessage: string, rateLimited: boolean): RunTurnResult {
    return {
      claudeSessionId: this._claudeSessionId,
      ok: false,
      costUsd: null,
      durationMs: null,
      errorMessage,
      rateLimited,
      interrupted: false,
    };
  }

  /** The process is gone (or being torn down): fail whatever was in flight, release waiters, tell the owner. Runs once. */
  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
    const failure = this.failedResult(reason, this.inflight?.sawRateLimitError ?? classifyRateLimit(reason));
    if (this.inflight) {
      logger.error("turn failed", { turnId: this.inflight.turnId, err: reason });
      this.settleInflight(failure, true);
    }
    if (this.autoTurn) {
      this.opts.emit({
        kind: "turn_result",
        turnId: this.autoTurn.turnId,
        promptId: this.autoTurn.promptId,
        promptIds: this.takeSteered(this.autoTurn.promptId),
        ok: false,
        costUsd: null,
        durationMs: null,
        errorMessage: reason,
        inputTokens: null,
        outputTokens: null,
        interrupted: false,
      });
      this.settleAutoTurn(failure);
    }
    this.backgroundTasks.clear();
    this.opts.onClosed?.(reason);
  }
}
