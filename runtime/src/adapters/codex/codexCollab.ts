import { clampSubagentText, SUBAGENT_LIMITS, type SubagentInfo, type SubagentPatch } from 'michi-shared';

/**
 * Codex multi-agent collaboration items (`collabAgentToolCall`).
 *
 * `spawnAgent` carries the delegated prompt and, once completed, the child
 * thread ids (`receiverThreadIds`) plus their `agentsStates`. Later collab
 * calls (`wait`, `sendInput`, …) report the same per-thread states. Child
 * thread ids are the roster keys, matching CodexSession's child tracking.
 */

export const CODEX_COLLAB_ITEM = 'collabAgentToolCall';

type Item = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const TOOL_TITLES: Record<string, string> = {
  spawnAgent: 'Spawn agent',
  wait: 'Wait for agents',
  sendInput: 'Message agent',
  closeAgent: 'Close agent',
  resumeAgent: 'Resume agent',
};

export function codexCollabTitle(item: Item): string {
  const tool = str(item['tool']) ?? 'agent';
  return TOOL_TITLES[tool] ?? tool.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** Only spawning is a delegation chip; the other collab calls are plain tools. */
export function codexCollabKind(item: Item): string {
  return item['tool'] === 'spawnAgent' ? 'subagent' : 'tool';
}

export function codexCollabInput(item: Item): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const key of ['tool', 'prompt', 'model', 'reasoningEffort', 'receiverThreadIds']) {
    if (item[key] !== undefined && item[key] !== null) input[key] = item[key];
  }
  if (item['tool'] === 'spawnAgent') input['subagent_type'] = 'codex';
  return input;
}

function stateEntry(threadId: string, state: unknown): Partial<SubagentInfo> {
  const raw = state && typeof state === 'object' ? state as Record<string, unknown> : {};
  const status = str(raw['status']);
  const message = str(raw['message']);
  switch (status) {
    case 'completed':
      return { status: 'terminated', outcome: 'completed', ...(message ? { result: clampSubagentText(message, SUBAGENT_LIMITS.result) } : {}) };
    case 'errored':
    case 'failed':
    case 'notFound':
      return { status: 'terminated', outcome: 'failed', ...(message ? { error: clampSubagentText(message, SUBAGENT_LIMITS.error) } : {}) };
    case 'shutdown':
    case 'closed':
      return { status: 'terminated', ...(message ? { statusMessage: oneLine(message, SUBAGENT_LIMITS.statusMessage) } : {}) };
    case 'running':
    case 'pendingInit':
      return { status: 'working', ...(message ? { statusMessage: oneLine(message, SUBAGENT_LIMITS.statusMessage) } : {}) };
    default:
      void threadId;
      return {};
  }
}

/**
 * Codex sub-agent activity items (`subAgentActivity`, codex-cli 0.156+),
 * which newer app-servers send instead of `collabAgentToolCall`.
 *
 * Each names one child thread (`agentThreadId`) and what happened to it
 * (`kind`): started, interacted, interrupted or completed. Only `started` is
 * a delegation: it carries the spawning call's id and is the chip. The item
 * carries no prompt or model, and the child thread sends no thread/started
 * or user message, so the task is unknown; the entry is named after the last
 * segment of `agentPath`. The child's own frames supply activity, result and
 * outcome (CodexSession). The other kinds are notices: `completed` arrives
 * on the parent thread after the child's own turn/completed (while the
 * parent is idle, it is dropped with the other parent frames).
 */
export const CODEX_SUBAGENT_ACTIVITY_ITEM = 'subAgentActivity';

/** Whether a `subAgentActivity` item is the spawn of a child thread. */
export function isCodexSubagentSpawn(item: Item): boolean {
  return item['kind'] === 'started' && !!str(item['agentThreadId']);
}

/**
 * Whether a parent-thread item starts a sub-agent: a `subAgentActivity`
 * spawn (the child exists) or a `spawnAgent` collab call (older
 * app-servers; the child may not exist yet). `childThreadId` is the child
 * when the item names one.
 */
export function codexSpawnSignal(item: Item): { childThreadId: string | null } | null {
  if (item['type'] === CODEX_SUBAGENT_ACTIVITY_ITEM) {
    return item['kind'] === 'started' ? { childThreadId: str(item['agentThreadId']) ?? null } : null;
  }
  if (item['type'] === CODEX_COLLAB_ITEM && item['tool'] === 'spawnAgent') {
    const receivers = Array.isArray(item['receiverThreadIds']) ? item['receiverThreadIds'] as unknown[] : [];
    const first = receivers.find((id): id is string => typeof id === 'string' && !!id);
    return { childThreadId: first ?? null };
  }
  return null;
}

function agentPathName(agentPath: string | undefined): string | undefined {
  const segments = (agentPath ?? '').split('/').filter(Boolean);
  const last = segments.at(-1);
  return last && last !== 'root' ? last : undefined;
}

export function codexSubagentSpawnInput(item: Item): Record<string, unknown> {
  const input: Record<string, unknown> = { tool: 'spawnAgent', subagent_type: 'codex' };
  const agentPath = str(item['agentPath']);
  if (agentPath) input['agentPath'] = agentPath;
  const threadId = str(item['agentThreadId']);
  if (threadId) input['receiverThreadIds'] = [threadId];
  return input;
}

/** The roster entry a `started` item opens. */
export function codexSubagentSpawnRoster(item: Item): SubagentPatch[] {
  const threadId = str(item['agentThreadId']);
  if (!threadId || item['kind'] !== 'started') return [];
  // No agentName: the UI shows it before sessionName, and 'codex' would
  // hide the path's name (it falls back to the thread id without one).
  const entry: SubagentPatch = { sessionId: threadId, source: 'codex', status: 'working' };
  const name = agentPathName(str(item['agentPath']));
  if (name) entry.sessionName = name;
  const itemId = str(item['id']);
  if (itemId) entry.parentToolCallId = itemId;
  return [entry];
}

/**
 * Roster patches for one completed collab item. `spawnAgent` seeds the task
 * and link; every collab item contributes the latest per-thread states. A
 * thread whose state is missing or unknown keeps its earlier status, and
 * names stay unset so the child's own nickname (thread/started) survives;
 * the UI falls back to the thread id.
 */
export function codexCollabRoster(item: Item): SubagentPatch[] {
  const receivers = Array.isArray(item['receiverThreadIds'])
    ? (item['receiverThreadIds'] as unknown[]).filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  const states = item['agentsStates'] && typeof item['agentsStates'] === 'object'
    ? item['agentsStates'] as Record<string, unknown>
    : {};
  const ids = new Set<string>([...receivers, ...Object.keys(states)]);
  const spawn = item['tool'] === 'spawnAgent';
  const prompt = str(item['prompt']);
  const itemId = str(item['id']);
  return [...ids].map((threadId) => {
    const entry: SubagentPatch = { sessionId: threadId, source: 'codex', ...stateEntry(threadId, states[threadId]) };
    if (spawn) {
      if (!entry.status) entry.status = 'working';
      if (prompt) {
        entry.initialQuery = oneLine(prompt.split('\n')[0], 200);
        entry.prompt = clampSubagentText(prompt, SUBAGENT_LIMITS.prompt);
      }
      const model = str(item['model']);
      if (model) entry.model = model;
      if (itemId) entry.parentToolCallId = itemId;
    }
    return entry;
  });
}
