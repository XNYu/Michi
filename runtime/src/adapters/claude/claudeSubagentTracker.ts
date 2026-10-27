import {
  clampSubagentText,
  extractToolUsePurpose,
  SUBAGENT_LIMITS,
  type SubagentInfo,
  type SubagentOutcome,
  type SubagentUsage,
} from 'michi-shared';
import type { NormalizedEvent } from '../../contract/events';
import type { ClaudeEnvelope } from './claudeEnvelopeParser';

/**
 * In-session Claude subagents (the `Agent` tool, formerly `Task`).
 *
 * Sources, all keyed by the parent tool_use id:
 *  - parent `tool_use` input: subagent_type / description / prompt / model;
 *  - `system` task_started / task_progress / task_updated / task_notification;
 *  - forwarded child envelopes (`--forward-subagent-text`, parent_tool_use_id):
 *    child tool_use → activity, child tool_result → activity result, child
 *    text → narration;
 *  - parent `tool_result` + structured `tool_use_result` → result and totals.
 *
 * Emits roster patches (`subagent_list_update` with one entry) and activity.
 * Nothing is emitted outside a turn: a frame between turns would open a
 * self-turn in ClaudeSession and hold the runtime lock.
 *
 * Backgrounded agents outlive their turn. The spawning message records them
 * as `background` (still running when its turn closed); the tracker carries
 * them into later turns, and the turn that sees them again — or the first
 * turn after they finished while idle — gets the full entry with its
 * outcome, under that turn's message.
 */

export const CLAUDE_SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

interface Entry extends SubagentInfo {
  messageSeq: number;
  /** Carried over from an earlier turn; not yet published in this one. */
  carried?: boolean;
}

type Emit = (ev: NormalizedEvent) => void;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Text of a tool_result / message content (string or block array). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = record(block);
      return b && b['type'] === 'text' && typeof b['text'] === 'string' ? b['text'] : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Subagent "now" label: the stated purpose, else tool + primary argument. */
export function toolActivityTitle(toolName: string, input: Record<string, unknown>): string {
  const purpose = extractToolUsePurpose(input);
  if (purpose) return purpose;
  if (typeof input.description === 'string') return input.description;
  if (typeof input.file_path === 'string') return `${toolName}: ${input.file_path}`;
  if (typeof input.pattern === 'string') {
    const path = typeof input.path === 'string' ? ` in ${input.path}` : '';
    return `grep: ${input.pattern}${path}`;
  }
  return toolName;
}

const DETAIL_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'notebook_path'];

/** One-line technical argument for an activity row. */
export function toolActivityDetail(input: Record<string, unknown>): string | undefined {
  for (const key of DETAIL_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value, SUBAGENT_LIMITS.detail);
  }
  return undefined;
}

function usageFrom(raw: Record<string, unknown> | undefined): SubagentUsage | undefined {
  if (!raw) return undefined;
  const usage: SubagentUsage = {};
  const tokens = num(raw['total_tokens']) ?? num(raw['totalTokens']);
  const tools = num(raw['tool_uses']) ?? num(raw['totalToolUseCount']);
  const duration = num(raw['duration_ms']) ?? num(raw['totalDurationMs']);
  if (tokens !== undefined) usage.totalTokens = tokens;
  if (tools !== undefined) usage.toolUses = tools;
  if (duration !== undefined) usage.durationMs = duration;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export interface ClaudeSubagentTracker {
  /** A parent-level tool_use block. Returns true when it spawned a subagent. */
  onParentToolUse(id: string, name: string, input: Record<string, unknown>): boolean;
  /** A parent-level tool_result block (user envelope). */
  onParentToolResult(block: Record<string, unknown>, env: ClaudeEnvelope): void;
  /** A forwarded child envelope (parent_tool_use_id set). */
  onChildEnvelope(env: ClaudeEnvelope, parentToolUseId: string): void;
  /** A `system` envelope. Returns true when it was a subagent task event. */
  onSystem(env: ClaudeEnvelope): boolean;
  /** Task ids the tracker must leave alone (dynamic workflows). */
  ignoreTask(taskId: string): void;
  startTurn(): void;
  /** system:init outside a foreground turn starts a self-initiated turn. */
  beginTurnIfIdle(): void;
  /** `result` envelope: close out the turn's roster. */
  endTurn(): void;
  isInTurn(): boolean;
  /**
   * A background agent still runs in this CLI process, or finished while
   * idle and no turn has reported its outcome yet. Disposing the process
   * now would lose that agent or its completion.
   */
  hasBackgroundWork(): boolean;
  /**
   * The agents hasBackgroundWork counts, as roster entries: still running
   * (no outcome), or finished while idle (with the outcome no turn reported).
   */
  pendingBackground(): SubagentInfo[];
}

export interface ClaudeSubagentTrackerOptions {
  /**
   * The background agents this process tracks changed (see
   * hasBackgroundWork); called with all of them after the call that
   * changed them.
   */
  onBackgroundChange?: (sessionIds: string[]) => void;
}

export function createClaudeSubagentTracker(
  emit: Emit,
  now: () => number = Date.now,
  options: ClaudeSubagentTrackerOptions = {},
): ClaudeSubagentTracker {
  const entries = new Map<string, Entry>();
  const taskToTool = new Map<string, string>();
  const ignoredTasks = new Set<string>();
  // A new translator is inside its first turn; only a `result` closes it.
  let inTurn = true;
  let reportedBackground: string[] = [];

  /** Still runs, or finished while idle and no turn has reported it yet. */
  function pendingEntries(): Entry[] {
    const pending: Entry[] = [];
    for (const entry of entries.values()) {
      // `carried` on a terminated entry: finished while idle, unpublished.
      if (entry.background && (entry.status === 'working' || entry.carried)) pending.push(entry);
    }
    return pending;
  }

  function backgroundIds(): string[] {
    return pendingEntries().map((entry) => entry.sessionId);
  }

  function syncBackground(): void {
    if (!options.onBackgroundChange) return;
    const ids = backgroundIds();
    if (ids.length === reportedBackground.length && ids.every((id, index) => id === reportedBackground[index])) return;
    reportedBackground = ids;
    options.onBackgroundChange([...ids]);
  }

  /** `fn`, then report a changed background set. */
  function synced<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args) => {
      try { return fn(...args); } finally { syncBackground(); }
    };
  }

  function wire(entry: Entry): SubagentInfo {
    const { messageSeq: _messageSeq, carried: _carried, ...info } = entry;
    return { ...info, ...(info.usage ? { usage: { ...info.usage } } : {}) };
  }

  function publish(entry: Entry): void {
    if (!inTurn) {
      // Changed between turns: the next turn publishes it.
      entry.carried = true;
      return;
    }
    entry.carried = false;
    emit({ kind: 'subagent_list_update', subagents: [wire(entry)] });
  }

  function activity(entry: Entry, ev: Omit<Extract<NormalizedEvent, { kind: 'subagent_tool_activity' }>, 'kind' | 'subagentSessionId'>): void {
    if (!inTurn) return;
    // A carried agent needs its full entry in this turn's roster first;
    // activity for an agent the roster doesn't know is dropped by the fold.
    if (entry.carried) publish(entry);
    emit({ kind: 'subagent_tool_activity', subagentSessionId: entry.sessionId, ...ev });
  }

  function markBackground(entry: Entry): void {
    if (entry.background) return;
    entry.background = true;
    publish(entry);
  }

  /** New turn: keep agents still running in the background, and ones that
   *  finished while idle and were never published; drop the rest. */
  function resetForTurn(): void {
    for (const [id, entry] of entries) {
      const keep = entry.background && (entry.status === 'working' || entry.carried);
      if (keep) entry.carried = true;
      else entries.delete(id);
    }
    for (const [taskId, toolId] of taskToTool) {
      if (!entries.has(toolId)) taskToTool.delete(taskId);
    }
    inTurn = true;
    // Completions that happened between turns belong to this turn.
    for (const entry of entries.values()) {
      if (entry.status === 'terminated') publish(entry);
    }
  }

  /** Get-or-create; a new entry is published once, with its seed applied. */
  function ensure(id: string, initial?: Partial<SubagentInfo>): Entry {
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        sessionId: id,
        sessionName: 'subagent',
        agentName: 'subagent',
        initialQuery: '',
        status: 'working',
        group: '',
        dependsOn: [],
        parentToolCallId: id,
        startedAt: now(),
        source: 'claude',
        messageSeq: 0,
      };
      entries.set(id, entry);
      if (initial) applySeed(entry, initial);
      publish(entry);
    } else if (initial) {
      seed(entry, initial);
    }
    return entry;
  }

  /** Apply a seed; publish when anything changed. */
  function seed(entry: Entry, patch: Partial<SubagentInfo>): void {
    if (applySeed(entry, patch)) publish(entry);
  }

  function applySeed(entry: Entry, patch: Partial<SubagentInfo>): boolean {
    let changed = false;
    const set = <K extends keyof SubagentInfo>(key: K, value: SubagentInfo[K] | undefined, onlyIfEmpty = true) => {
      if (value === undefined || value === '') return;
      const current = entry[key];
      const empty = current === undefined || current === '' || current === 'subagent';
      if (onlyIfEmpty && !empty) return;
      if (current === value) return;
      entry[key] = value as Entry[K];
      changed = true;
    };
    set('agentName', patch.agentName);
    set('sessionName', patch.sessionName);
    set('initialQuery', patch.initialQuery);
    set('description', patch.description);
    set('prompt', patch.prompt);
    set('model', patch.model);
    set('statusMessage', patch.statusMessage, false);
    if (patch.usage) {
      entry.usage = { ...entry.usage, ...patch.usage };
      changed = true;
    }
    return changed;
  }

  function finish(
    entry: Entry,
    outcome: SubagentOutcome,
    patch: { result?: string; error?: string; usage?: SubagentUsage; model?: string; authoritative?: boolean } = {},
  ): void {
    let changed = entry.status !== 'terminated' || !entry.outcome;
    entry.status = 'terminated';
    if (!entry.outcome) entry.outcome = outcome;
    if (entry.endedAt === undefined) entry.endedAt = now();
    // The structured hand-back is the report the parent actually received;
    // it replaces a task_notification summary that arrived first.
    const result = clampSubagentText(patch.result?.trim() || undefined, SUBAGENT_LIMITS.result);
    if (result && (!entry.result || (patch.authoritative && entry.result !== result))) { entry.result = result; changed = true; }
    const error = clampSubagentText(patch.error?.trim() || undefined, SUBAGENT_LIMITS.error);
    if (error && !entry.error) { entry.error = error; changed = true; }
    if (patch.usage) { entry.usage = { ...entry.usage, ...patch.usage }; changed = true; }
    if (patch.model && entry.model !== patch.model && (!entry.model || patch.authoritative)) { entry.model = patch.model; changed = true; }
    if (changed) publish(entry);
  }

  function entryForTask(env: ClaudeEnvelope): Entry | undefined {
    const taskId = str(env['task_id']);
    if (taskId && ignoredTasks.has(taskId)) return undefined;
    const toolUseId = str(env['tool_use_id']) ?? (taskId ? taskToTool.get(taskId) : undefined);
    return toolUseId ? entries.get(toolUseId) : undefined;
  }

  const tracker: ClaudeSubagentTracker = {
    onParentToolUse(id, name, input) {
      if (!id || !CLAUDE_SUBAGENT_TOOLS.has(name)) return false;
      const subagentType = str(input['subagent_type']);
      const description = str(input['description']);
      const prompt = str(input['prompt']);
      ensure(id, {
        agentName: subagentType ?? 'general-purpose',
        sessionName: description ?? subagentType,
        initialQuery: description ?? (prompt ? oneLine(prompt.split('\n')[0], 200) : undefined),
        description,
        prompt: clampSubagentText(prompt, SUBAGENT_LIMITS.prompt),
        model: str(input['model']),
      });
      return true;
    },

    onParentToolResult(block, env) {
      const toolUseId = str(block['tool_use_id']);
      const entry = toolUseId ? entries.get(toolUseId) : undefined;
      if (!entry) return;
      const structured = record(env['tool_use_result']);
      const status = str(structured?.['status']);
      const isError = block['is_error'] === true;
      // A backgrounded subagent returns a launch placeholder; it finishes
      // later through task_notification.
      if (!isError && entry.status !== 'terminated'
        && (entry.background || (status && status !== 'completed' && status !== 'failed'))) {
        markBackground(entry);
        return;
      }
      const structuredText = contentText(structured?.['content']);
      // Without a structured result the raw text carries the harness frame;
      // it is still the best record when nothing else arrived.
      if (entry.status === 'terminated' && !structuredText && !structured) return;
      const text = structuredText || contentText(block['content']);
      const usage = usageFrom(structured);
      const model = str(structured?.['resolvedModel']);
      const authoritative = !!structuredText;
      if (isError || status === 'failed') finish(entry, 'failed', { error: text, usage, model, authoritative });
      else finish(entry, 'completed', { result: text, usage, model, authoritative });
    },

    onChildEnvelope(env, parentToolUseId) {
      const entry = ensure(parentToolUseId);
      if (entry.status === 'terminated') return; // late frames after the hand-back
      const type = str(env['type']);
      const message = record(env['message']);
      const content = message?.['content'];
      if (type === 'user') {
        // The first child user message is the delegated prompt.
        if (!entry.prompt && typeof content === 'string') seed(entry, { prompt: clampSubagentText(content, SUBAGENT_LIMITS.prompt) });
        if (!Array.isArray(content)) return;
        for (const raw of content) {
          const b = record(raw);
          if (!b) continue;
          if (b['type'] === 'text' && !entry.prompt && typeof b['text'] === 'string') {
            seed(entry, { prompt: clampSubagentText(b['text'], SUBAGENT_LIMITS.prompt) });
          } else if (b['type'] === 'tool_result') {
            const toolCallId = str(b['tool_use_id']);
            if (!toolCallId) continue;
            const output = clampSubagentText(contentText(b['content']) || undefined, SUBAGENT_LIMITS.output);
            activity(entry, {
              toolCallId,
              title: '',
              status: b['is_error'] === true ? 'failed' : 'completed',
              ...(output ? { output } : {}),
            });
          }
        }
        return;
      }
      if (type !== 'assistant' || !Array.isArray(content)) return;
      for (const raw of content) {
        const b = record(raw);
        if (!b) continue;
        if (b['type'] === 'tool_use') {
          const name = str(b['name']) ?? 'tool';
          const input = record(b['input']) ?? {};
          const detail = toolActivityDetail(input);
          activity(entry, {
            ...(str(b['id']) ? { toolCallId: str(b['id']) } : {}),
            title: toolActivityTitle(name, input),
            status: 'in_progress',
            toolKind: name,
            ...(detail ? { detail } : {}),
          });
        } else if (b['type'] === 'text' && typeof b['text'] === 'string') {
          const text = oneLine(b['text'], SUBAGENT_LIMITS.title);
          if (!text) continue;
          entry.messageSeq += 1;
          activity(entry, {
            toolCallId: `${entry.sessionId}:m:${entry.messageSeq}`,
            title: text,
            status: '',
            activityKind: 'message',
          });
        }
      }
    },

    onSystem(env) {
      const subtype = str(env['subtype']);
      if (subtype !== 'task_started' && subtype !== 'task_progress' && subtype !== 'task_updated' && subtype !== 'task_notification') return false;
      const taskId = str(env['task_id']);
      if (subtype === 'task_started') {
        const taskType = str(env['task_type']);
        const toolUseId = str(env['tool_use_id']);
        if (taskType === 'local_workflow') {
          if (taskId) ignoredTasks.add(taskId);
          return false;
        }
        if (!toolUseId || (taskType && taskType !== 'local_agent' && !str(env['subagent_type']))) return true;
        if (taskId) taskToTool.set(taskId, toolUseId);
        const description = str(env['description']);
        const entry = ensure(toolUseId, {
          agentName: str(env['subagent_type']),
          sessionName: description,
          initialQuery: description,
          description,
          prompt: clampSubagentText(str(env['prompt']), SUBAGENT_LIMITS.prompt),
        });
        if (env['is_backgrounded'] === true) markBackground(entry);
        return true;
      }
      const entry = entryForTask(env);
      if (!entry) return taskId ? !ignoredTasks.has(taskId) : true;
      if (subtype === 'task_progress') {
        const summary = str(env['summary']) ?? str(env['description']);
        seed(entry, {
          ...(summary ? { statusMessage: clampSubagentText(oneLine(summary, SUBAGENT_LIMITS.statusMessage), SUBAGENT_LIMITS.statusMessage) } : {}),
          ...(usageFrom(record(env['usage'])) ? { usage: usageFrom(record(env['usage'])) } : {}),
        });
        return true;
      }
      if (subtype === 'task_updated') {
        const patch = record(env['patch']);
        const status = str(patch?.['status']);
        const endTime = num(patch?.['end_time']);
        if (endTime !== undefined && entry.endedAt === undefined) entry.endedAt = endTime;
        if (status === 'completed') finish(entry, 'completed');
        else if (status === 'failed') finish(entry, 'failed', { error: str(patch?.['error']) });
        else if (status === 'killed') finish(entry, 'cancelled', { error: str(patch?.['error']) });
        return true;
      }
      // task_notification: the final edge.
      const status = str(env['status']);
      const summary = str(env['summary']);
      const usage = usageFrom(record(env['usage']));
      if (status === 'completed') finish(entry, 'completed', { result: summary, usage });
      else if (status === 'failed') finish(entry, 'failed', { error: summary, usage });
      else if (status === 'stopped') {
        // A stopped task's summary is usually its own description (CLI
        // 2.1.310 on Stop), which says nothing about why it stopped.
        const reason = summary && summary !== entry.description && summary !== entry.sessionName ? summary : undefined;
        finish(entry, 'cancelled', { error: reason, usage });
      }
      return true;
    },

    ignoreTask(taskId) {
      ignoredTasks.add(taskId);
    },

    startTurn() {
      resetForTurn();
    },

    beginTurnIfIdle() {
      if (inTurn) return;
      resetForTurn();
    },

    endTurn() {
      // Never leave a foreground subagent pinned on "working" past its turn
      // (a missed hand-back): the outcome stays unknown. Background agents
      // really are still running; the projection records them as such and
      // the tracker carries them into the next turn.
      for (const entry of entries.values()) {
        if (entry.status === 'working' && !entry.background) {
          entry.status = 'terminated';
          entry.endedAt = entry.endedAt ?? now();
          publish(entry);
        }
      }
      inTurn = false;
    },

    isInTurn: () => inTurn,

    hasBackgroundWork: () => backgroundIds().length > 0,

    pendingBackground: () => pendingEntries().map(wire),
  };
  return {
    ...tracker,
    onParentToolUse: synced(tracker.onParentToolUse),
    onParentToolResult: synced(tracker.onParentToolResult),
    onChildEnvelope: synced(tracker.onChildEnvelope),
    onSystem: synced(tracker.onSystem),
    startTurn: synced(tracker.startTurn),
    beginTurnIfIdle: synced(tracker.beginTurnIfIdle),
    endTurn: synced(tracker.endTurn),
  };
}
