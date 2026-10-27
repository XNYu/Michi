import type { MetaAgentChatTurnContext, MichiAssistantRuntimeSwitch, MichiAssistantConversations } from 'michi-shared';
import { API_BASE_URL } from '../../config/env';
import type { AgentReasoning, RuntimeId } from './agentRuntime';

// The ⌘J assistant: one dedicated Michi chat node in a hidden system
// workspace, served by the local backend's `/api/assistant`. Older backends
// answer 404; callers treat that as "no assistant here".

export interface AssistantSettings {
  runtimeId: RuntimeId;
  /** Null = the runtime's default model. */
  modelId: string | null;
  /** Null = the model's default reasoning. */
  reasoning: AgentReasoning | null;
}

export interface AssistantInfo {
  nodeId: string;
  workspaceId: string;
  treeId: string;
  settings: AssistantSettings;
  /**
   * What the current conversation runs on: once it has messages it keeps its
   * runtime, so this can differ from `settings` (the next conversation's).
   * Absent from older backends.
   */
  conversation?: AssistantSettings;
  supportedRuntimes: RuntimeId[];
  /** Where the conversation moved to another runtime, oldest first. Absent from older backends. */
  runtimeSwitches?: MichiAssistantRuntimeSwitch[];
}

export type AssistantSettingsPatch = Partial<AssistantSettings>;

/** Fired on window after the assistant starts over; `detail` is the new AssistantInfo. */
export const MICHI_ASSISTANT_RESET_EVENT = 'michi:assistant-reset';

export class AssistantApiError extends Error {
  readonly status: number;
  /** True when this backend has no (usable) assistant: a 404, or an answer of the wrong shape. */
  readonly missing: boolean;
  constructor(status: number, message: string, missing = status === 404) {
    super(message);
    this.name = 'AssistantApiError';
    this.status = status;
    this.missing = missing;
  }
}

/** True for an error that means "no assistant here", so callers hide it rather than report a failure. */
export function isAssistantMissing(err: unknown): boolean {
  return err instanceof AssistantApiError && err.missing;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAssistantInfo(value: unknown): value is AssistantInfo {
  return isObject(value)
    && typeof value.nodeId === 'string' && value.nodeId !== ''
    && typeof value.workspaceId === 'string' && value.workspaceId !== ''
    && isObject(value.settings) && typeof value.settings.runtimeId === 'string'
    && Array.isArray(value.supportedRuntimes) && value.supportedRuntimes.every((id) => typeof id === 'string');
}

async function assistantJson(path: string, init?: { method: 'PUT' | 'POST'; body?: unknown }): Promise<AssistantInfo> {
  const res = await fetch(`${API_BASE_URL}/assistant${path}`, init ? {
    method: init.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(init.body ?? {}),
  } : undefined);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AssistantApiError(
      res.status,
      typeof body?.error === 'string' ? body.error : `Assistant request failed (${res.status})`,
    );
  }
  if (!isAssistantInfo(body)) throw new AssistantApiError(res.status, 'Unexpected assistant response', true);
  return body;
}

export function fetchAssistant(): Promise<AssistantInfo> {
  return assistantJson('');
}

/** Applies to the assistant's next conversation; the current one keeps its settings. */
export function updateAssistantSettings(patch: AssistantSettingsPatch): Promise<AssistantInfo> {
  return assistantJson('/settings', { method: 'PUT', body: patch });
}

/** Starts the assistant over in a fresh conversation. */
export function resetAssistant(nodeId?: string): Promise<AssistantInfo> {
  return assistantJson('/reset', { method: 'POST', ...(nodeId ? { body: { nodeId } } : {}) });
}

export async function fetchAssistantConversations(cursor?: string, signal?: AbortSignal): Promise<MichiAssistantConversations> {
  const params = new URLSearchParams({ limit: '5', ...(cursor ? { cursor } : {}) });
  const res = await fetch(`${API_BASE_URL}/assistant/conversations?${params}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new AssistantApiError(res.status, body?.error ?? 'Could not load conversations');
  if (!body || !Array.isArray(body.items) || !body.items.every((item: Record<string, unknown>) => typeof item.nodeId === 'string' && typeof item.title === 'string' && typeof item.updatedAt === 'number')
    || !(body.nextCursor === null || typeof body.nextCursor === 'string')) throw new AssistantApiError(200, 'Unexpected conversation history');
  return body;
}

export function activateAssistantConversation(nodeId: string, currentNodeId: string): Promise<AssistantInfo> {
  return assistantJson(`/conversations/${encodeURIComponent(nodeId)}/activate`, { method: 'POST', body: { currentNodeId } });
}

const turnContexts = new Map<string, () => MetaAgentChatTurnContext | null>();

/**
 * Supplies `metaAgentContext` for every message sent to the assistant's
 * conversation `nodeId` (the Spaces window registers it while it is shown).
 * The backend refuses the field on any other chat, so register only that node.
 * Returns the unregister function.
 */
export function provideMetaAgentTurnContext(nodeId: string, read: () => MetaAgentChatTurnContext | null): () => void {
  turnContexts.set(nodeId, read);
  return () => { if (turnContexts.get(nodeId) === read) turnContexts.delete(nodeId); };
}

/** The context the next message to `nodeId` carries, read when it is sent. */
export function metaAgentTurnContextFor(nodeId: string): MetaAgentChatTurnContext | undefined {
  return turnContexts.get(nodeId)?.() ?? undefined;
}
