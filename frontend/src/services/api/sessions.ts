import {
  activeBackendApiBase,
  backendApiBase,
  backendConnectionIdForWorkspace,
  nodeBackendApiBase,
  workspaceBackendApiBase,
} from '../../config/backendConnections';
import { parseAgentDefinitionDtoV1, type AgentDefinitionDtoV1 } from 'michi-shared';
import { startupMark } from '../startupTrace';
import type { RuntimeId, AgentReasoning } from './agentRuntime';

export interface ModelInfo {
  model_id: string;
  model_name: string;
  description?: string;
  context_window_tokens?: number;
}

export async function listModels(): Promise<{ models: ModelInfo[]; defaultModel: string | null }> {
  try {
    const res = await fetch(`${activeBackendApiBase()}/models`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    return { models: body.models || [], defaultModel: body.default_model ?? null };
  } catch {
    return { models: [], defaultModel: null };
  }
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export async function listAgentModes(): Promise<SessionMode[]> {
  const res = await fetch(`${activeBackendApiBase()}/modes`);
  if (!res.ok) throw new Error(`listAgentModes failed: ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.availableModes) ? body.availableModes : [];
}


/**
 * Pre-warm the backend's ACP client + warmed session pool for this cwd.
 * Call on hydrate / workspace switch / workspace creation so the next
 * chat in that cwd is fast.
 *
 * Resolves after the backend has a warm slot ready for the cwd. That means
 * the request can take several seconds on a cold Kiro/Claude process, but the
 * next chat should avoid paying that session creation cost.
 *
 * Errors are swallowed at the call site — warm is an optimization, not
 * a prerequisite. If it fails, first chat just falls through the old
 * slow path instead of the fast pool-hit path.
 */
export async function warmCwd(cwd: string, connectionId?: string): Promise<void> {
  const startedAt = Date.now();
  startupMark('warm_request_start', { cwd });
  let res: Response;
  try {
    res = await fetch(`${backendApiBase(connectionId)}/warm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
  } catch (err) {
    startupMark('warm_request_failed', { cwd, durMs: Date.now() - startedAt, error: (err as Error).message });
    throw err;
  }
  if (!res.ok) {
    startupMark('warm_request_failed', { cwd, status: res.status, durMs: Date.now() - startedAt });
    throw new Error(`warmCwd failed: ${res.status}`);
  }
  startupMark('warm_request_done', { cwd, status: res.status, durMs: Date.now() - startedAt });
}

/**
 * "Test Connection": ask the backend to force-respawn the runtime for a cwd /
 * workspace and probe backend reachability. Powers the affordance shown after a
 * connection-class turn failure. Unlike warmCwd, errors are surfaced (not
 * swallowed) — the whole point is to report the connection's health. Resolves
 * `{ ok }` on success or `{ ok:false, detail }` with the backend's reason.
 */
export async function checkRuntimeHealth(
  target: { cwd?: string; workspaceId?: string },
): Promise<{ ok: boolean; detail?: string }> {
  let res: Response;
  try {
    const base = target.workspaceId ? workspaceBackendApiBase(target.workspaceId) : activeBackendApiBase();
    res = await fetch(`${base}/runtime/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    });
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
  if (!res.ok) {
    return { ok: false, detail: `health check failed: ${res.status}` };
  }
  try {
    return (await res.json()) as { ok: boolean; detail?: string };
  } catch {
    return { ok: false, detail: 'invalid health response' };
  }
}

export type ResumeStrategy = 'fresh' | 'live' | 'exact' | 'compatible';

export interface EnsureSessionOptions {
  nodeId: string;
  chatId?: string | null;
  cwd?: string;
  workspaceId?: string;
  parentChatId?: string;
  mergeContexts?: string[];
  model?: string;
  extraContexts?: Array<{ name: string; filePath: string; url?: string; size?: number; kind?: 'embedded' | 'reference' | 'symlink' }>;
  enableFollowUps?: boolean;
  contextManifest?: Array<{ name: string; filePath: string; url?: string; kind?: 'embedded' | 'reference' | 'symlink' }>;
  priorMessages?: Array<{ role: 'user' | 'assistant'; text: string }>;
  runtimeId?: RuntimeId;
  providerId?: string | null;
  modelId?: string | null;
  reasoning?: AgentReasoning | null;
  /** Desired agent/mode to apply when a fresh session is created (pre-session pick). */
  modeId?: string | null;
  resumeFingerprint?: string | null;
  graphPrerequisite?: Record<string, unknown>;
  agentDefinitionId?: string;
}

export interface PrimaryAgentDefinitionOption {
  backendConnectionId: string;
  definition: AgentDefinitionDtoV1;
}

interface PendingPrimaryAgentBinding {
  workspaceId: string;
  backendConnectionId: string;
  definitionId: string;
}

const pendingPrimaryAgents = new Map<string, PendingPrimaryAgentBinding>();

/** Bind a Home/new-thread selection to exactly the first ensure-session call. */
export function bindPendingPrimaryAgent(
  nodeId: string,
  binding: PendingPrimaryAgentBinding,
): void {
  const ownerBackend = backendConnectionIdForWorkspace(binding.workspaceId);
  if (binding.backendConnectionId !== ownerBackend) {
    throw new Error('The selected Agent belongs to a different Backend than this Workspace.');
  }
  pendingPrimaryAgents.set(nodeId, binding);
}

export function clearPendingPrimaryAgent(nodeId: string): void {
  pendingPrimaryAgents.delete(nodeId);
}

export async function listPrimaryAgentDefinitions(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<PrimaryAgentDefinitionOption[]> {
  const backendConnectionId = backendConnectionIdForWorkspace(workspaceId);
  const response = await fetch(
    `${workspaceBackendApiBase(workspaceId)}/agents?workspaceId=${encodeURIComponent(workspaceId)}&discover=enabled`,
    { signal },
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `listPrimaryAgentDefinitions failed: ${response.status}`;
    throw new Error(message);
  }
  const definitions = payload && typeof payload === 'object' && 'definitions' in payload && Array.isArray(payload.definitions)
    ? payload.definitions
    : [];
  return definitions.map((definition, index) => ({
    backendConnectionId,
    definition: parseAgentDefinitionDtoV1(definition, `definitions[${index}]`),
  }));
}

export interface EnsureSessionResult {
  chatId: string;
  currentModeId: string | null;
  runtimeId?: RuntimeId;
  providerId?: string | null;
  modelId?: string | null;
  reasoning?: AgentReasoning | null;
  resumeFingerprint?: string | null;
  resumeStrategy: ResumeStrategy;
  resumeReason?: string;
}

/**
 * Generate node IDs locally using `crypto.randomUUID()`. This is the same
 * format the backend produces (`n-${randomUUID()}`) but avoids a network
 * round-trip, which is critical when the backend event loop is busy with
 * concurrent ensure-session / SQLite operations. UUID v4 collision probability
 * is ~2^-122, so local generation is safe.
 */
export function allocateNodeIdsLocal(count = 1): string[] {
  return Array.from({ length: count }, () => `n-${crypto.randomUUID()}`);
}

/**
 * Allocate node IDs from the backend. Retained for cases where server-side
 * coordination is genuinely needed (currently none). Prefer
 * `allocateNodeIdsLocal` for all normal UI-driven node creation.
 */
export async function allocateNodeIds(count = 1, connectionId?: string): Promise<string[]> {
  const base = connectionId ? backendApiBase(connectionId) : activeBackendApiBase();
  const res = await fetch(`${base}/node-ids/allocate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  if (!res.ok) throw new Error(`allocateNodeIds failed: ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.nodeIds) || body.nodeIds.length !== count) {
    throw new Error('allocateNodeIds returned an invalid response');
  }
  return body.nodeIds as string[];
}

export async function ensureSession(opts: EnsureSessionOptions): Promise<EnsureSessionResult> {
  const startedAt = Date.now();
  startupMark('ensure_session_start', { nodeId: opts.nodeId, chatId: opts.chatId, cwd: opts.cwd, workspaceId: opts.workspaceId });
  const body: Record<string, unknown> = {};
  if (opts.chatId) body.chatId = opts.chatId;
  if (opts.cwd) body.cwd = opts.cwd;
  if (opts.workspaceId) body.workspaceId = opts.workspaceId;
  if (opts.parentChatId) body.parentChatId = opts.parentChatId;
  if (opts.mergeContexts && opts.mergeContexts.length > 0) body.mergeContexts = opts.mergeContexts;
  if (opts.model) body.model = opts.model;
  if (opts.extraContexts && opts.extraContexts.length > 0) body.extraContexts = opts.extraContexts;
  if (opts.enableFollowUps === false) body.enableFollowUps = false;
  if (opts.contextManifest && opts.contextManifest.length > 0) body.contextManifest = opts.contextManifest;
  if (opts.priorMessages) body.priorMessages = opts.priorMessages;
  if (opts.runtimeId) body.runtimeId = opts.runtimeId;
  if (opts.modeId) body.modeId = opts.modeId;
  if (opts.providerId) body.providerId = opts.providerId;
  if (opts.modelId) body.modelId = opts.modelId;
  if (opts.reasoning) body.reasoning = opts.reasoning;
  if (opts.resumeFingerprint) body.resumeFingerprint = opts.resumeFingerprint;
  if (opts.graphPrerequisite) body.graphPrerequisite = opts.graphPrerequisite;
  const pendingPrimary = pendingPrimaryAgents.get(opts.nodeId);
  if (pendingPrimary) {
    if (opts.workspaceId !== pendingPrimary.workspaceId) {
      throw new Error('The selected primary Agent no longer matches this Workspace.');
    }
    if (backendConnectionIdForWorkspace(pendingPrimary.workspaceId) !== pendingPrimary.backendConnectionId) {
      throw new Error('The selected primary Agent no longer matches this Workspace Backend.');
    }
    body.agentDefinitionId = pendingPrimary.definitionId;
  } else if (opts.agentDefinitionId) {
    body.agentDefinitionId = opts.agentDefinitionId;
  }

  const base = opts.workspaceId ? workspaceBackendApiBase(opts.workspaceId) : nodeBackendApiBase(opts.nodeId);
  const res = await fetch(`${base}/nodes/${encodeURIComponent(opts.nodeId)}/ensure-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let payload: { code?: string; error?: string } | null = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    if (payload?.code === 'CLAUDE_SESSIONS_BUSY') {
      startupMark('ensure_session_failed', { nodeId: opts.nodeId, status: res.status, code: payload.code, durMs: Date.now() - startedAt });
      throw new Error(
        'Claude slots are busy. Stop a running reply or wait for one to finish, then retry.',
      );
    }
    startupMark('ensure_session_failed', { nodeId: opts.nodeId, status: res.status, durMs: Date.now() - startedAt });
    throw new Error(payload?.error || `ensureSession failed: ${res.status} ${raw}`);
  }
  const json = await res.json();
  if (pendingPrimary) pendingPrimaryAgents.delete(opts.nodeId);
  startupMark('ensure_session_done', {
    nodeId: opts.nodeId,
    chatId: json.chatId,
    resumeStrategy: json.resumeStrategy ?? 'compatible',
    durMs: Date.now() - startedAt,
  });
  return {
    chatId: json.chatId as string,
    currentModeId: json.currentModeId ?? null,
    runtimeId: json.runtimeId as RuntimeId | undefined,
    providerId: json.providerId ?? null,
    modelId: json.modelId ?? null,
    reasoning: json.reasoning ?? null,
    resumeFingerprint: json.resumeFingerprint ?? null,
    resumeStrategy: (json.resumeStrategy ?? 'compatible') as ResumeStrategy,
    resumeReason: typeof json.resumeReason === 'string' ? json.resumeReason : undefined,
  };
}

export async function setChatMode(chatId: string, modeId: string): Promise<string> {
  const res = await fetch(`${nodeBackendApiBase(chatId)}/chats/${chatId}/set-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modeId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(err.error || `setMode failed: ${res.status}`);
  }
  const json = await res.json();
  return json.currentModeId as string;
}
