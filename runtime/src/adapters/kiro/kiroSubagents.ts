import {
  clampSubagentText,
  extractToolUsePurpose,
  SUBAGENT_LIMITS,
  type SubagentActivityPayload,
  type SubagentInfo,
} from 'michi-shared';

/**
 * Kiro subagent mapping (pure; KiroSession owns the stream loop).
 *
 * V2 publishes a native roster (`_kiro.dev/subagent/list_update`) and runs each
 * stage in its own child session; AcpClient forwards that session's tool calls.
 * V3 has no roster: the delegation is a parent tool call tagged
 * `_meta.kiro.kind = "agent-subtask"`, and every child tool call and narration
 * chunk arrives on the parent session tagged `_meta.kiro.agentSubtaskId`.
 */

type Raw = Record<string, any>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function kiroSubtaskId(update: Raw | undefined): string | undefined {
  return str(update?._meta?.kiro?.agentSubtaskId);
}

export function isKiroDelegation(update: Raw | undefined): boolean {
  return update?._meta?.kiro?.kind === 'agent-subtask' && !!kiroSubtaskId(update);
}

function isTerminal(status: unknown): boolean {
  return status === 'completed' || status === 'failed' || status === 'error' || status === 'cancelled';
}

/** One-line technical argument (command, path, pattern) for an activity row. */
export function kiroToolDetail(update: Raw): string | undefined {
  const input = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput as Raw : {};
  const candidates = [
    input.command,
    input.path,
    Array.isArray(input.operations) ? input.operations.map((op: Raw) => op?.path).filter(Boolean).join(', ') : undefined,
    input.pattern,
    input.query,
    input.url,
    Array.isArray(update.locations) ? update.locations[0]?.path : undefined,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return oneLine(value, SUBAGENT_LIMITS.detail);
  }
  return undefined;
}

/** Text of a tool result across V2 (`rawOutput.items[].Text`) and V3 shapes. */
export function kiroToolOutputText(update: Raw): string | undefined {
  const raw = update.rawOutput;
  if (typeof raw === 'string') return raw || undefined;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.items)) {
      const text = raw.items.map((item: Raw) => typeof item?.Text === 'string' ? item.Text
        : typeof item?.Json === 'object' ? JSON.stringify(item.Json) : '').filter(Boolean).join('\n');
      if (text) return text;
    }
    if (typeof raw.message === 'string' && raw.message) return raw.message;
  }
  if (Array.isArray(update.content)) {
    const text = update.content
      .map((block: Raw) => block?.type === 'content' && block.content?.type === 'text' ? block.content.text : '')
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  if (raw && typeof raw === 'object') return JSON.stringify(raw);
  return undefined;
}

/** Activity payload for one child tool frame. */
export function kiroChildToolActivity(subagentSessionId: string, update: Raw): SubagentActivityPayload {
  const purpose = extractToolUsePurpose(update.rawInput);
  const detail = kiroToolDetail(update);
  const toolKind = str(update.kind) ?? str(update._meta?.kiro?.toolName);
  const output = isTerminal(update.status) ? clampSubagentText(kiroToolOutputText(update), SUBAGENT_LIMITS.output) : undefined;
  return {
    subagentSessionId,
    title: oneLine(purpose ?? str(update.title) ?? toolKind ?? 'tool', SUBAGENT_LIMITS.title),
    status: str(update.status) ?? 'in_progress',
    ...(str(update.toolCallId) ? { toolCallId: str(update.toolCallId) } : {}),
    ...(toolKind ? { toolKind } : {}),
    ...(detail ? { detail } : {}),
    ...(output ? { output } : {}),
  };
}

/** V2: the subagent's `summary` tool carries its final report. */
export function kiroV2SummaryResult(update: Raw): string | undefined {
  if (update.status !== 'completed') return undefined;
  const toolName = str(update._meta?.kiro?.toolName);
  const result = str(update.rawInput?.taskResult);
  if (!result) return undefined;
  if (toolName && toolName !== 'summary') return undefined;
  if (!toolName && !/^summari[sz]ing/i.test(String(update.title ?? ''))) return undefined;
  return result;
}

/** V2 roster entry → shared contract (merge-safe patch). */
export function kiroV2RosterEntry(raw: Raw, parentToolCallId?: string): SubagentInfo {
  const initialQuery = String(raw.initialQuery ?? '');
  const statusType = String(raw.status?.type ?? '');
  const working = statusType === 'working';
  const entry: SubagentInfo = {
    sessionId: String(raw.sessionId ?? ''),
    sessionName: String(raw.sessionName ?? ''),
    agentName: String(raw.agentName ?? raw.role ?? ''),
    initialQuery: initialQuery ? oneLine(initialQuery.split('\n')[0], 200) : '',
    status: working ? 'working' : 'terminated',
    group: String(raw.group ?? ''),
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
    source: 'kiro',
  };
  const prompt = clampSubagentText(initialQuery || undefined, SUBAGENT_LIMITS.prompt);
  if (prompt) entry.prompt = prompt;
  if (raw.status?.message) entry.statusMessage = oneLine(String(raw.status.message), SUBAGENT_LIMITS.statusMessage);
  if (statusType === 'failed' || statusType === 'error') entry.outcome = 'failed';
  else if (statusType === 'cancelled') entry.outcome = 'cancelled';
  if (entry.outcome && raw.status?.message) entry.error = clampSubagentText(String(raw.status.message), SUBAGENT_LIMITS.error);
  if (typeof raw.createdAtMs === 'number') entry.startedAt = raw.createdAtMs;
  if (parentToolCallId) entry.parentToolCallId = parentToolCallId;
  return entry;
}

/** V2 result patch: the `summary` tool is the stage's final report. */
export function kiroV2ResultPatch(subagentSessionId: string, result: string): SubagentInfo {
  return {
    sessionId: subagentSessionId,
    sessionName: '',
    agentName: '',
    initialQuery: '',
    status: 'terminated',
    group: '',
    dependsOn: [],
    outcome: 'completed',
    result: clampSubagentText(result, SUBAGENT_LIMITS.result),
  };
}

/** V3: roster patch for the delegation tool call itself. */
export function kiroV3DelegationEntry(update: Raw): SubagentInfo | null {
  const id = kiroSubtaskId(update);
  if (!id) return null;
  const input = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput as Raw : {};
  const titleName = /^sub-?agent:\s*(.+)$/i.exec(String(update.title ?? ''))?.[1]?.trim();
  const name = str(input.name) ?? titleName ?? '';
  const prompt = str(input.prompt);
  const explanation = str(input.explanation);
  const status = update.status;
  const terminal = isTerminal(status);
  const entry: SubagentInfo = {
    sessionId: id,
    sessionName: name,
    agentName: name,
    initialQuery: explanation ? oneLine(explanation, 200) : prompt ? oneLine(prompt.split('\n')[0], 200) : '',
    status: terminal ? 'terminated' : 'working',
    group: '',
    dependsOn: [],
    source: 'kiro',
    ...(str(update.toolCallId) ? { parentToolCallId: str(update.toolCallId) } : {}),
  };
  if (explanation) entry.description = oneLine(explanation, SUBAGENT_LIMITS.title);
  const clampedPrompt = clampSubagentText(prompt, SUBAGENT_LIMITS.prompt);
  if (clampedPrompt) entry.prompt = clampedPrompt;
  if (terminal) {
    const text = kiroToolOutputText(update);
    if (status === 'completed') {
      entry.outcome = 'completed';
      const result = clampSubagentText(text, SUBAGENT_LIMITS.result);
      if (result) entry.result = result;
    } else {
      entry.outcome = status === 'cancelled' ? 'cancelled' : 'failed';
      const error = clampSubagentText(text, SUBAGENT_LIMITS.error);
      if (error) entry.error = error;
    }
  }
  return entry;
}

/**
 * Coalesces a V3 subagent's streamed narration into one activity entry per
 * native message (`replayId`). Emits at sentence boundaries or every
 * `stride` characters so a token stream does not become an event stream.
 */
export function createSubtaskNarration(stride = 160) {
  interface Segment { replayId: string; key: string; text: string; emittedLength: number }
  const buffers = new Map<string, Segment>();
  /** Segments opened per subagent; names segments without a replay id. */
  const opened = new Map<string, number>();
  /** Boundaries crossed within one replay id (narration resumed after a tool). */
  const resumed = new Map<string, number>();

  function open(subagentSessionId: string, replayId: string): Segment {
    const count = opened.get(subagentSessionId) ?? 0;
    opened.set(subagentSessionId, count + 1);
    const resumes = replayId ? resumed.get(`${subagentSessionId}\u0000${replayId}`) ?? 0 : 0;
    const key = replayId ? (resumes > 0 ? `${replayId}.${resumes}` : replayId) : String(count);
    const segment = { replayId, key, text: '', emittedLength: 0 };
    buffers.set(subagentSessionId, segment);
    return segment;
  }

  function payload(subagentSessionId: string, buffer: Segment): SubagentActivityPayload {
    return {
      subagentSessionId,
      toolCallId: `${subagentSessionId}:m:${buffer.key}`,
      title: oneLine(buffer.text, SUBAGENT_LIMITS.title),
      status: '',
      activityKind: 'message',
    };
  }

  function flush(subagentSessionId: string): SubagentActivityPayload | null {
    const buffer = buffers.get(subagentSessionId);
    if (!buffer || buffer.text.trim().length === 0 || buffer.emittedLength === buffer.text.length) return null;
    buffer.emittedLength = buffer.text.length;
    return payload(subagentSessionId, buffer);
  }

  return {
    push(subagentSessionId: string, replayId: string | undefined, text: string): SubagentActivityPayload[] {
      const out: SubagentActivityPayload[] = [];
      let buffer = buffers.get(subagentSessionId);
      const key = replayId ?? '';
      if (buffer && buffer.replayId !== key) {
        const flushed = flush(subagentSessionId);
        if (flushed) out.push(flushed);
        buffer = undefined;
      }
      if (!buffer) buffer = open(subagentSessionId, key);
      // Narration beyond the row limit is never shown; stop growing it.
      if (buffer.text.length < SUBAGENT_LIMITS.title * 2) buffer.text += text;
      const pending = buffer.text.length - buffer.emittedLength;
      if (pending >= stride || (pending > 0 && /[.!?。！？\n]\s*$/.test(text))) {
        const flushed = flush(subagentSessionId);
        if (flushed) out.push(flushed);
      }
      return out;
    },
    flush,
    /**
     * A tool or completion interrupts the narration: flush it and make the
     * next chunk start a new row, so the trail keeps narration and tools in
     * order and the "now" line follows the latest words.
     */
    boundary(subagentSessionId: string): SubagentActivityPayload | null {
      const flushed = flush(subagentSessionId);
      const buffer = buffers.get(subagentSessionId);
      if (buffer && buffer.text) {
        buffers.delete(subagentSessionId);
        if (buffer.replayId) {
          const id = `${subagentSessionId}\u0000${buffer.replayId}`;
          resumed.set(id, (resumed.get(id) ?? 0) + 1);
        }
      }
      return flushed;
    },
    flushAll(): SubagentActivityPayload[] {
      return [...buffers.keys()].flatMap((id) => {
        const flushed = flush(id);
        return flushed ? [flushed] : [];
      });
    },
    clear(): void {
      buffers.clear();
    },
  };
}
