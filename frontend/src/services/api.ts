import {
  CHAT_STREAM_EVENTS,
  dispatchChatStreamEvent,
  parseChatStreamEvent,
} from './chatStreamEvents';
import type { StreamHandlers } from './chatStreamEvents';
import { startupMark } from './startupTrace';

export type { AgentCommand, PlanEntry, StreamHandlers } from './chatStreamEvents';
export type { PermissionRequest } from '../state/chatTypes';

import { API_BASE_URL } from '../config/env';

export type UploadPhase = 'preparing' | 'uploading';

let cachedStreamProbeEnabled: boolean | null = null;

function streamProbeEnabled(): boolean {
  if (cachedStreamProbeEnabled !== null) return cachedStreamProbeEnabled;
  if (typeof window === 'undefined') return false;
  try {
    cachedStreamProbeEnabled = window.localStorage.getItem('michi:stream-probe') === '1';
    return cachedStreamProbeEnabled;
  } catch {
    cachedStreamProbeEnabled = false;
    return false;
  }
}

function writeStreamProbe(row: Record<string, unknown>): void {
  if (!streamProbeEnabled()) return;
  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ type: 'stream_probe', source: 'renderer', ...row }));
}

export interface UploadProgress {
  phase: UploadPhase;
  loaded: number;
  total: number | null;
  percent: number | null;
}

export interface UploadProgressOptions {
  onProgress?: (progress: UploadProgress) => void;
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function combineUploadProgress(
  onProgress: ((progress: UploadProgress) => void) | undefined,
  phase: UploadPhase,
  startPercent: number,
  endPercent: number,
): ((progress: UploadProgress) => void) | undefined {
  if (!onProgress) return undefined;
  return (progress) => {
    const pct = progress.percent == null
      ? null
      : clampPercent(startPercent + (progress.percent / 100) * (endPercent - startPercent));
    onProgress({
      ...progress,
      phase,
      percent: pct,
    });
  };
}

function readFileAsArrayBuffer(
  file: File,
  onProgress?: (progress: UploadProgress) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    onProgress?.({
      phase: 'preparing',
      loaded: 0,
      total: file.size || null,
      percent: file.size === 0 ? 100 : 0,
    });
    reader.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size || null;
      onProgress?.({
        phase: 'preparing',
        loaded: event.loaded,
        total,
        percent: total ? clampPercent((event.loaded / total) * 100) : null,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => {
      onProgress?.({
        phase: 'preparing',
        loaded: file.size,
        total: file.size || null,
        percent: 100,
      });
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error('file read did not produce bytes'));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsArrayBuffer(file);
  });
}

function postJsonWithUploadProgress<T>(
  path: string,
  payload: unknown,
  options?: UploadProgressOptions,
): Promise<T> {
  const body = JSON.stringify(payload);
  if (!options?.onProgress) {
    return fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `status ${res.status}` }));
        throw new Error(err.error || `request failed: ${res.status}`);
      }
      return res.json() as Promise<T>;
    });
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}${path}`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : null;
      options.onProgress?.({
        phase: 'uploading',
        loaded: event.loaded,
        total,
        percent: total ? clampPercent((event.loaded / total) * 100) : null,
      });
    };
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.onabort = () => reject(new Error('upload cancelled'));
    xhr.onload = () => {
      const raw = xhr.responseText || '{}';
      let json: any;
      try {
        json = JSON.parse(raw);
      } catch {
        json = { error: raw || `status ${xhr.status}` };
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(json?.error || `request failed: ${xhr.status}`));
        return;
      }
      options.onProgress?.({
        phase: 'uploading',
        loaded: body.length,
        total: body.length,
        percent: 100,
      });
      resolve(json as T);
    };
    options.onProgress?.({
      phase: 'uploading',
      loaded: 0,
      total: body.length,
      percent: 0,
    });
    xhr.send(body);
  });
}

export interface ModelInfo {
  model_id: string;
  model_name: string;
  description?: string;
  context_window_tokens?: number;
}

export async function listModels(): Promise<{ models: ModelInfo[]; defaultModel: string | null }> {
  try {
    const res = await fetch(`${API_BASE_URL}/models`);
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
  const res = await fetch(`${API_BASE_URL}/modes`);
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
export async function warmCwd(cwd: string): Promise<void> {
  const startedAt = Date.now();
  startupMark('warm_request_start', { cwd });
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/warm`, {
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

export type ResumeStrategy = 'fresh' | 'live' | 'exact' | 'compatible';

export interface EnsureSessionOptions {
  nodeId: string;
  chatId?: string | null;
  cwd?: string;
  workspaceId?: string;
  parentChatId?: string;
  mergeContexts?: string[];
  model?: string;
  extraContexts?: Array<{ name: string; filePath: string; url?: string; size?: number; kind?: 'embedded' | 'reference' }>;
  enableFollowUps?: boolean;
  contextManifest?: Array<{ name: string; filePath: string; url?: string; kind?: 'embedded' | 'reference' }>;
  priorMessages?: Array<{ role: 'user' | 'assistant'; text: string }>;
  runtimeId?: RuntimeId;
  providerId?: string | null;
  modelId?: string | null;
  reasoning?: AgentReasoning | null;
  /** Desired agent/mode to apply when a fresh session is created (pre-session pick). */
  modeId?: string | null;
  resumeFingerprint?: string | null;
  graphPrerequisite?: Record<string, unknown>;
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

export async function allocateNodeIds(count = 1): Promise<string[]> {
  const res = await fetch(`${API_BASE_URL}/node-ids/allocate`, {
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

  const res = await fetch(`${API_BASE_URL}/nodes/${encodeURIComponent(opts.nodeId)}/ensure-session`, {
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

const webCwdCache = new Map<string, string>();
export async function getWebUploadCwd(workspaceId: string): Promise<string> {
  const cached = webCwdCache.get(workspaceId);
  if (cached) return cached;
  const res = await fetch(`${API_BASE_URL}/uploads/web-cwd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(err.error || `getWebUploadCwd failed: ${res.status}`);
  }
  const json = await res.json();
  if (typeof json?.cwd !== 'string') throw new Error('getWebUploadCwd: missing cwd');
  webCwdCache.set(workspaceId, json.cwd);
  return json.cwd;
}

// Cloud mode requires `workspaceId` so the backend can:
//   1. enforce per-user ownership via requireWorkspaceOwner
//   2. derive the sandbox cwd server-side and ignore the client cwd
// Desktop mode ignores workspaceId and uses the client-supplied cwd directly,
// so the parameter is required by the type but harmless when omitted in tests.
export async function importWorkspaceFile(
  workspaceId: string,
  cwd: string,
  originalName: string,
  content: string,
  options?: UploadProgressOptions & { subdir?: string },
): Promise<{ name: string; displayName?: string; filePath: string; size: number }> {
  try {
    return await postJsonWithUploadProgress(
      '/workspaces/import-file',
      { workspaceId, cwd, originalName, content, subdir: options?.subdir },
      options,
    );
  } catch (err) {
    throw new Error((err as Error).message || 'importWorkspaceFile failed');
  }
}

export async function importWorkspaceFileBinary(
  workspaceId: string,
  cwd: string,
  originalName: string,
  bytes: ArrayBuffer | Uint8Array,
  options?: UploadProgressOptions & { subdir?: string },
): Promise<{ name: string; displayName?: string; filePath: string; size: number }> {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Encode to base64 in chunks to avoid String.fromCharCode argument cap on
  // large blobs (~125k arg limit on some engines).
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
  }
  const contentBase64 = btoa(binary);
  try {
    return await postJsonWithUploadProgress(
      '/workspaces/import-file',
      { workspaceId, cwd, originalName, contentBase64, subdir: options?.subdir },
      options,
    );
  } catch (err) {
    throw new Error((err as Error).message || 'importWorkspaceFileBinary failed');
  }
}

export async function importWorkspaceFileUpload(
  workspaceId: string,
  cwd: string,
  file: File,
  options?: UploadProgressOptions & { originalName?: string; subdir?: string },
): Promise<{ name: string; displayName?: string; filePath: string; size: number }> {
  const originalName = options?.originalName ?? file.name;
  if (file.size === 0) {
    return importWorkspaceFile(workspaceId, cwd, originalName, '', options);
  }
  const readProgress = combineUploadProgress(options?.onProgress, 'preparing', 0, 10);
  const uploadProgress = combineUploadProgress(options?.onProgress, 'uploading', 10, 100);
  const bytes = await readFileAsArrayBuffer(file, readProgress);
  return importWorkspaceFileBinary(workspaceId, cwd, originalName, bytes, {
    onProgress: uploadProgress,
    subdir: options?.subdir,
  });
}

export async function setChatMode(chatId: string, modeId: string): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/set-mode`, {
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

export interface ExportRequestPayload {
  workspace: {
    name: string;
    cwd?: string;
    createdAt: number;
  };
  rootTitle: string;
  nodes: Array<{
    nodeId: string;
    parentNodeId?: string;
    title?: string;
    depth: number;
    messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  }>;
  cwd?: string;
  nodeIds?: string[];
}

function createClientTurnId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Web Crypto is available in every supported renderer, but retaining a
  // fallback keeps the transport usable in stripped-down test/webview hosts.
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Consume an SSE stream produced by the backend. Returns a cancel function
 * that aborts the fetch (also calls /cancel on the backend).
 */
export function streamMessage(
  nodeId: string,
  text: string,
  handlers: StreamHandlers,
  ownerToken?: string,
  durable?: {
    /** Generated before POST so replay is possible before the first frame. */
    turnId?: string;
    displayText?: string;
    userMetadata?: {
      quotedText?: string;
      attachments?: Array<{ name: string; absPath: string }>;
      comments?: Array<Record<string, unknown>>;
    };
  },
): () => void {
  const controller = new AbortController();
  const probeEnabled = streamProbeEnabled();

  // ── Terminal-state safety net ──
  // The assistant node leaves `status: 'streaming'` only when a `done`/`error`
  // event reaches the reducer. If the connection ends or silently stalls
  // without one, we MUST still finalize the node — otherwise it stays pinned in
  // "streaming" forever (frozen, no spinner, Stop does nothing).
  const STREAM_SILENCE_TIMEOUT_MS = 30_000; // 3× the backend's 10s heartbeat
  let terminalSeen = false; // a done/error frame was dispatched to the reducer
  let settled = false;      // a synthetic terminal handler has fired
  let watchdogTimedOut = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  // Do not wait for turn_start to learn this: a broken response can occur
  // after the server began the turn but before any SSE bytes reach us.
  // The server requires nodeId for a durable foreground turn. Preserve the
  // legacy no-node helper behavior used by a few lightweight callers/tests.
  const clientTurnId = nodeId ? (durable?.turnId ?? createClientTurnId()) : '';
  let resumeTurnId = clientTurnId;
  let resumeSeq = -1;
  let resumeCancel: (() => void) | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let resumeAttempt = 0;
  let cancelledByUser = false;
  let sawFirstByte = false;
  const resumeForeground = (): boolean => {
    if (!resumeTurnId || cancelledByUser || resumeCancel || resumeTimer) return false;
    resumeCancel = subscribeChat(nodeId, {
      ...handlers,
      onEnvelope: (envelope) => {
        if (envelope.turnId) resumeTurnId = envelope.turnId;
        if (typeof envelope.seq === 'number') resumeSeq = Math.max(resumeSeq, envelope.seq);
        return handlers.onEnvelope?.(envelope);
      },
      onDone: (...args) => { terminalSeen = true; handlers.onDone?.(...args); },
      onError: (...args) => { terminalSeen = true; handlers.onError?.(...args); },
    }, { turnId: resumeTurnId, seq: resumeSeq + 1 }, {
      onOpen: () => { resumeAttempt = 0; },
      onDisconnect: (result) => {
        resumeCancel = null;
        if (terminalSeen || cancelledByUser || settled) return;
        if (!result.retryable) {
          settleError(result.error?.message ?? 'turn replay unavailable');
          return;
        }
        const delay = Math.min(5_000, 250 * (2 ** resumeAttempt++));
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          if (!resumeForeground()) settleError('turn replay ended before completion');
        }, delay);
      },
    });
    return true;
  };

  const clearWatchdog = () => {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  };
  function settleError(message: string): void {
    if (settled || terminalSeen) return;
    settled = true;
    clearWatchdog();
    handlers.onError?.(message);
  }
  function settleAborted(): void {
    if (settled || terminalSeen) return;
    settled = true;
    clearWatchdog();
    handlers.onAborted?.();
  }
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdogTimedOut = true;
      controller.abort(); // unstick a half-open reader.read() that never resolves
      if (!resumeTurnId) settleError('stream stalled — no data received');
    }, STREAM_SILENCE_TIMEOUT_MS);
  };

  (async () => {
    try {
      const payload: Record<string, unknown> = { text };
      if (clientTurnId) payload.turnId = clientTurnId;
      if (nodeId) payload.nodeId = nodeId;
      if (ownerToken) payload.ownerToken = ownerToken;
      if (durable?.displayText !== undefined) payload.displayText = durable.displayText;
      if (durable?.userMetadata) payload.userMetadata = durable.userMetadata;
      const startedAt = Date.now();
      startupMark('stream_request_start', { chatId: nodeId, nodeId, textLen: text.length });
      const res = await fetch(`${API_BASE_URL}/chats/${nodeId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
      sawFirstByte = true;
      startupMark('stream_response_headers', { chatId: nodeId, nodeId, status: res.status, durMs: Date.now() - startedAt });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let sawFirstEvent = false;
      let sawFirstChunk = false;
      let chunkSeq = 0;
      let prevChunkAt = 0;

      armWatchdog();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        armWatchdog(); // bytes arrived (incl. heartbeats) — reset the silence timer
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split('\n');
          let evt = 'message';
          let data = '';
          for (const l of lines) {
            if (l.startsWith('event:')) evt = l.slice(6).trim();
            // SSE spec: strip exactly ONE leading space after `data:` if
            // present, then concatenate verbatim. Calling .trim() here was
            // eating leading/trailing whitespace inside the JSON payload —
            // not just outside it — and corrupting multi-byte UTF-8 frames
            // whose first byte happened to be ASCII whitespace.
            else if (l.startsWith('data:')) {
              const rest = l.slice(5);
              data += rest.startsWith(' ') ? rest.slice(1) : rest;
            }
          }
          if (!data) continue;
          const parsed = parseChatStreamEvent(evt, data);
          if (!parsed) continue;
          if (parsed.data.turnId) resumeTurnId = parsed.data.turnId;
          if (typeof parsed.data.seq === 'number') resumeSeq = Math.max(resumeSeq, parsed.data.seq);
          if (!sawFirstEvent) {
            sawFirstEvent = true;
            startupMark('first_sse_event', { chatId: nodeId, nodeId, event: parsed.event, durMs: Date.now() - startedAt });
          }
          if (!sawFirstChunk && parsed.event === 'chunk') {
            sawFirstChunk = true;
            startupMark('first_sse_chunk', { chatId: nodeId, nodeId, durMs: Date.now() - startedAt });
          }
          if (probeEnabled && parsed.event === CHAT_STREAM_EVENTS.chunk) {
            const now = Date.now();
            chunkSeq += 1;
            writeStreamProbe({
              phase: 'sse_chunk',
              chatId: nodeId,
              nodeId,
              seq: chunkSeq,
              chars: parsed.data.text.length,
              bytes: new TextEncoder().encode(parsed.data.text).length,
              dtMs: prevChunkAt === 0 ? 0 : now - prevChunkAt,
              sinceStartMs: now - startedAt,
            });
            prevChunkAt = now;
          }
          if (
            parsed.event === CHAT_STREAM_EVENTS.done ||
            parsed.event === CHAT_STREAM_EVENTS.error
          ) {
            terminalSeen = true;
            clearWatchdog();
          }
          dispatchChatStreamEvent(parsed, handlers);
        }
      }
      // A foreground runner can outlive its first HTTP response. Reattach to
      // the same immutable turn/cursor rather than handing it to background
      // SSE (which intentionally never carries user turns).
      if (!terminalSeen && resumeForeground()) return;
      // Connection closed before we received a turn id, so no safe replay is
      // possible. Surface a terminal error rather than silently mixing feeds.
      settleError('stream closed before completion');
    } catch (err: any) {
      // Only attempt foreground resume if we received a successful HTTP
      // response (the turn was started on the backend). When the POST itself
      // fails (409 turn-already-active, 404, etc.) the turn was never started
      // and subscribing to it always 410s — surface the real error instead.
      if (!terminalSeen && !cancelledByUser && sawFirstByte && resumeForeground()) return;
      if (err?.name === 'AbortError') {
        // A user/navigation abort finalizes as aborted. A watchdog abort with
        // no stamped turn id cannot safely resume.
        if (watchdogTimedOut) settleError('stream stalled — no data received');
        else settleAborted();
      } else {
        settleError(err?.message || String(err));
      }
    } finally {
      clearWatchdog();
    }
  })();

  return () => {
    cancelledByUser = true;
    settleAborted();
    clearWatchdog();
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = null;
    controller.abort();
    resumeCancel?.();
    cancelChat(nodeId, ownerToken, resumeTurnId || clientTurnId).catch(() => {});
  };
}

export async function cancelChat(chatId: string, ownerToken?: string, turnId?: string): Promise<void> {
  await fetch(`${API_BASE_URL}/chats/${chatId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(ownerToken ? { ownerToken } : {}),
      ...(turnId ? { turnId } : {}),
    }),
  });
}

export interface ChatStreamDisconnect {
  retryable: boolean;
  error?: Error;
}

class SseHttpError extends Error {
  constructor(public readonly status: number, prefix = 'subscribe failed') {
    super(`${prefix}: ${status}`);
  }
}

export function subscribeChat(
  chatId: string,
  handlers: StreamHandlers,
  from: { turnId?: string; seq?: number } = {},
  opts: {
    onOpen?: () => void;
    onDisconnect?: (result: ChatStreamDisconnect) => void;
    onError?: (err: Error) => void;
  } = {},
): () => void {
  const controller = new AbortController();
  let stopped = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimedOut = false;
  const clearWatchdog = () => {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  };
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdogTimedOut = true;
      controller.abort();
    }, 30_000);
  };
  (async () => {
    let disconnect: ChatStreamDisconnect = { retryable: true };
    try {
      const query = new URLSearchParams();
      query.set('fromSeq', String(from.seq ?? 0));
      if (from.turnId) query.set('fromTurnId', from.turnId);
      const res = await fetch(`${API_BASE_URL}/chats/${chatId}/stream?${query.toString()}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new SseHttpError(res.status);
      if (!res.body) throw new Error('subscribe response has no body');
      opts.onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      armWatchdog();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        armWatchdog();
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split('\n');
          let evt = 'message';
          let data = '';
          for (const l of lines) {
            if (l.startsWith('event:')) evt = l.slice(6).trim();
            else if (l.startsWith('data:')) {
              const rest = l.slice(5);
              data += rest.startsWith(' ') ? rest.slice(1) : rest;
            }
          }
          if (!data) continue;
          const parsed = parseChatStreamEvent(evt, data);
          if (parsed) dispatchChatStreamEvent(parsed, handlers);
        }
      }
    } catch (err) {
      const original = err instanceof Error ? err : new Error(String(err));
      const error = watchdogTimedOut ? new Error('turn replay stalled — no data received') : original;
      disconnect = {
        retryable: !(original instanceof SseHttpError)
          || original.status >= 500
          || original.status === 408
          || original.status === 429,
        error,
      };
      if (!stopped) opts.onError?.(error);
    } finally {
      clearWatchdog();
      if (!stopped) opts.onDisconnect?.(disconnect);
    }
  })();
  return () => {
    stopped = true;
    clearWatchdog();
    controller.abort();
  };
}

export interface BackgroundDisconnect {
  retryable: boolean;
  error?: Error;
}

export interface SubscribeBackgroundOptions {
  onOpen?: () => void;
  onDisconnect?: (result: BackgroundDisconnect) => void;
  onError?: (err: Error) => void;
  cursors?: Record<string, { turnId: string; seq: number }>;
  /**
   * Reconcile an evicted replay cursor before any later frame is delivered.
   * The parser awaits this callback, turning the control frame into a real
   * ordering barrier instead of racing a stale snapshot against live data.
   */
  onReplayGap?: (
    gap: { chatId: string; nodeId?: string; turnId: string; seq: number },
    signal: AbortSignal,
  ) => void | Promise<void>;
}

const OBSERVER_SILENCE_TIMEOUT_MS = 30_000;

function observerDisconnectFor(error: Error): BackgroundDisconnect {
  return {
    retryable: !(error instanceof SseHttpError) || error.status >= 500,
    error,
  };
}

/**
 * The one Window-lifetime background feed. It carries runtime self-turns
 * only; user initiated turns stay on their own direct /message stream.
 */
export function subscribeBackground(
  handlersForChat: (chatId: string, nodeId?: string) => StreamHandlers,
  opts: SubscribeBackgroundOptions = {},
): () => void {
  const controller = new AbortController();
  let stopped = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  };
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => controller.abort(), OBSERVER_SILENCE_TIMEOUT_MS);
  };

  (async () => {
    let disconnect: BackgroundDisconnect = { retryable: true };
    try {
      const res = await fetch(`${API_BASE_URL}/chats/background/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursors: opts.cursors ?? {} }),
        signal: controller.signal,
      });
      if (!res.ok) throw new SseHttpError(res.status);
      if (!res.body) throw new Error('subscribe response has no body');
      opts.onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      armWatchdog();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (stopped) break;
        armWatchdog();
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split('\n');
          let evt = 'message';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              const rest = line.slice(5);
              data += rest.startsWith(' ') ? rest.slice(1) : rest;
            }
          }
          if (!data) continue;
          if (evt === 'background_sync_required') {
            let gap: Record<string, unknown> | null = null;
            try {
              gap = JSON.parse(data) as Record<string, unknown>;
            } catch {
              // Malformed control frames are ignored like malformed events.
            }
            if (
              gap
              && typeof gap.chatId === 'string'
              && typeof gap.turnId === 'string'
              && typeof gap.seq === 'number'
            ) {
              // Deliberately outside the JSON parse catch: reconciliation
              // failures must close this feed so the transport reconnects and
              // retries the same durable gap instead of silently moving on.
              await opts.onReplayGap?.({
                chatId: gap.chatId,
                nodeId: typeof gap.nodeId === 'string' ? gap.nodeId : undefined,
                turnId: gap.turnId,
                seq: gap.seq,
              }, controller.signal);
            }
            continue;
          }
          const parsed = parseChatStreamEvent(evt, data);
          const chatId = parsed?.data.chatId;
          if (!parsed || !chatId) continue;
          dispatchChatStreamEvent(parsed, handlersForChat(chatId, parsed.data.nodeId));
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      disconnect = observerDisconnectFor(error);
      if (!stopped) {
        controller.abort();
        opts.onError?.(error);
      }
    } finally {
      clearWatchdog();
      if (!stopped) opts.onDisconnect?.(disconnect);
    }
  })();
  return () => {
    stopped = true;
    clearWatchdog();
    controller.abort();
  };
}

export interface ClaimResult {
  owner: boolean;
  heldBy?: string;
}

export async function claimPane(chatId: string, ownerToken: string, windowId: string): Promise<ClaimResult> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerToken, windowId }),
  });
  if (!res.ok) return { owner: false };
  return res.json() as Promise<ClaimResult>;
}

export async function heartbeatPane(chatId: string, ownerToken: string): Promise<boolean> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerToken }),
  });
  return res.ok;
}

export async function releasePane(chatId: string, ownerToken: string): Promise<void> {
  await fetch(`${API_BASE_URL}/chats/${chatId}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerToken }),
  }).catch(() => {});
}

// ── Permission Response API ──

export async function respondToPermission(
  chatId: string,
  requestId: number,
  optionId: string,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/permission-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, optionId }),
  });
  if (!res.ok) throw new Error(`Permission response failed: ${res.status}`);
}

export async function cancelPermission(
  chatId: string,
  requestId: number,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/permission-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, cancel: true }),
  });
  if (!res.ok) throw new Error(`Permission response failed: ${res.status}`);
}

// ── User Input Response API ──

export async function respondToUserInput(
  chatId: string,
  requestId: number,
  answers: Array<{ question: string; answer: string }>,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/user-input-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, answers }),
  });
  if (!res.ok) throw new Error(`User input response failed: ${res.status}`);
}

export async function skipUserInput(
  chatId: string,
  requestId: number,
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/chats/${chatId}/user-input-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, skip: true }),
  });
  if (!res.ok) throw new Error(`User input skip failed: ${res.status}`);
}

// ── Persistence API ──

export async function fetchWorkspaces(): Promise<unknown[]> {
  const res = await fetch(`${API_BASE_URL}/workspaces`);
  if (!res.ok) throw new Error(`fetchWorkspaces failed: ${res.status}`);
  const body = await res.json();
  return body.workspaces ?? body;
}

export async function fetchAllWorkspaces(): Promise<unknown[]> {
  const res = await fetch(`${API_BASE_URL}/workspaces/all`);
  if (!res.ok) throw new Error(`fetchAllWorkspaces failed: ${res.status}`);
  const body = await res.json();
  return body.workspaces ?? [];
}

/**
 * Lazy-load hydration payload: every workspace's structure + per-node
 * message_count, with NO message bodies. Bodies are fetched per-tree on demand
 * via {@link fetchTreeMessages}. Throws on unreachability (same as
 * fetchAllWorkspaces) so the hydration barrier can retry.
 */
export async function fetchAllWorkspacesMeta(): Promise<unknown[]> {
  const res = await fetch(`${API_BASE_URL}/workspaces/all?meta=1`);
  if (!res.ok) throw new Error(`fetchAllWorkspacesMeta failed: ${res.status}`);
  const body = await res.json();
  return body.workspaces ?? [];
}

/** Lazy-load: all message-body rows for one tree. Backend orders by (node, seq). */
export async function fetchTreeMessages(workspaceId: string, treeId: string): Promise<unknown[]> {
  const res = await fetch(
    `${API_BASE_URL}/workspaces/${encodeURIComponent(workspaceId)}/trees/${encodeURIComponent(treeId)}/messages`,
  );
  if (!res.ok) throw new Error(`fetchTreeMessages failed: ${res.status}`);
  const body = await res.json();
  return body.messages ?? [];
}

export async function fetchWorkspace(id: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${API_BASE_URL}/workspaces/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`fetchWorkspace failed: ${res.status}`);
  return res.json();
}

export interface PersistenceCapabilities {
  protocolVersion: number;
  authoritativeTurnPersistence: boolean;
  durableNodePrerequisite: boolean;
  explicitCommands: boolean;
  backgroundWorkspaceSync: boolean;
  legacySyncAccepted: boolean;
}

export async function fetchPersistenceCapabilities(): Promise<PersistenceCapabilities> {
  const res = await fetch(`${API_BASE_URL}/persistence/capabilities`);
  if (!res.ok) throw new Error(`fetchPersistenceCapabilities failed: ${res.status}`);
  return res.json();
}

export interface WorkspaceCommand {
  type: 'workspace.upsert' | 'tree.upsert' | 'tree.delete' | 'node.upsert' | 'node.patch'
    | 'edge.upsert' | 'edge.delete' | 'context.upsert' | 'context.delete';
  payload: Record<string, unknown>;
}

export async function applyWorkspaceCommands(
  workspaceId: string,
  operationId: string,
  commands: readonly WorkspaceCommand[],
): Promise<void> {
  if (commands.length === 0) return;
  const res = await fetch(`${API_BASE_URL}/workspaces/${encodeURIComponent(workspaceId)}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationId, commands }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(body.error || `applyWorkspaceCommands failed: ${res.status}`);
  }
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/workspaces/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteWorkspace failed: ${res.status}`);
}

/**
 * Physically purge every soft-deleted node in a workspace. Called from the
 * Empty Trash UI BEFORE clearing local state. Returns the count of rows
 * actually removed.
 */
export async function emptyWorkspaceTrash(workspaceId: string): Promise<{ ok: boolean; purged: number }> {
  const res = await fetch(`${API_BASE_URL}/workspaces/${workspaceId}/trash/empty`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`emptyWorkspaceTrash failed: ${res.status}`);
  return res.json();
}

/**
 * Physically purge a specific set of nodes from a workspace. Used for the
 * "delete permanently" action on a single trash group. Empty list is a no-op.
 */
export async function purgeWorkspaceNodes(
  workspaceId: string,
  nodeIds: string[],
): Promise<{ ok: boolean; purged: number }> {
  const res = await fetch(`${API_BASE_URL}/workspaces/${workspaceId}/nodes`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeIds }),
  });
  if (!res.ok) throw new Error(`purgeWorkspaceNodes failed: ${res.status}`);
  return res.json();
}

export async function moveTreeToWorkspace(
  treeId: string,
  fromWorkspaceId: string,
  toWorkspaceId: string,
): Promise<{ movedNodes: number; movedEdges: number; droppedEdges: number }> {
  const res = await fetch(`${API_BASE_URL}/trees/${encodeURIComponent(treeId)}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromWorkspaceId, toWorkspaceId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(err.error || `moveTreeToWorkspace failed: ${res.status}`);
  }
  const body = await res.json();
  return {
    movedNodes: body.movedNodes ?? 0,
    movedEdges: body.movedEdges ?? 0,
    droppedEdges: body.droppedEdges ?? 0,
  };
}

// ── Prefs API (SQLite-backed, survives port changes) ──

export async function fetchPrefs(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/prefs`);
    if (!res.ok) return null;
    const body = await res.json();
    return body.prefs ?? null;
  } catch {
    return null;
  }
}

export async function savePrefs(prefs: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/prefs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prefs),
    });
  } catch {
    // Best-effort: localStorage is the fallback.
  }
}

// ── Search API ──

export interface SearchResult {
  id: string;
  node_id: string;
  node_title: string | null;
  workspace_id: string;
  workspace_name: string;
  tree_id: string;
  role: string;
  snippet: string;
  created_at: number;
}

export async function searchMessages(
  query: string,
  workspaceId?: string,
  mode: 'keyword' | 'semantic' = 'keyword',
  limit = 20,
): Promise<{ results: SearchResult[]; total: number }> {
  const params = new URLSearchParams({ q: query, mode, limit: String(limit) });
  if (workspaceId) params.set('workspaceId', workspaceId);
  const res = await fetch(`${API_BASE_URL}/search?${params}`);
  if (!res.ok) throw new Error(`searchMessages failed: ${res.status}`);
  return res.json();
}

export interface VersionInfo {
  localHash: string;
  localDate: string;
  remoteHash: string | null;
  remoteName: string | null;
  updateAvailable: boolean;
}

export interface UpdateResult {
  ok: boolean;
  newHash?: string;
  error?: string;
  requiresConfirm?: boolean;
  reason?: 'dirty' | 'ahead';
  aheadCount?: number;
  remoteName?: string;
  branch?: string;
  backupRef?: string;
}

export async function checkVersion(): Promise<VersionInfo> {
  const res = await fetch(`${API_BASE_URL}/version`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

export async function triggerUpdate(force = false): Promise<UpdateResult> {
  const res = await fetch(`${API_BASE_URL}/version/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  return res.json();
}

// === Agent runtime API ===

export type AgentReasoning = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type RuntimeId = string;

export interface AgentCapabilities {
  modes: boolean;
  permissions: boolean;
  models?: boolean;
  providerModels: boolean;
  reasoning: boolean;
  /** Reasoning levels this runtime accepts. Empty when reasoning=false. Optional for backward-compat. */
  supportedReasoningLevels?: AgentReasoning[];
  apiKeys: boolean;
  warmSessions: boolean;
  saveContext: boolean;
  spawnBranches: boolean;
  /** True iff loadSession() restores meaningful agent-side state (vs. SQLite replay). Optional for backward-compat. */
  nativeResume?: boolean;
}

export interface AgentProviderInfo {
  id: string;
  label: string;
  keyLabel: string;
  envVars: string[];
  defaultModel: string;
  keyUrl?: string;
  supportsReasoning: boolean;
  hasKey?: boolean;
  requiresUserKey?: boolean;
  modelLocked?: boolean;
}

export interface AgentRuntimeOption {
  id: RuntimeId;
  label: string;
  available: boolean;
  /** True iff this runtime needs a user-supplied API key before it can run. */
  requiresApiKey?: boolean;
}

export interface AgentStatus {
  runtime: RuntimeId;
  label: string;
  capabilities: AgentCapabilities;
  availableRuntimes: AgentRuntimeOption[];
  provider?: string;
  providers?: AgentProviderInfo[];
  /** Resolved model id for the active runtime. */
  model?: string;
  /** Per-runtime model overrides set by the user. */
  modelByRuntime?: Record<string, string>;
  /** Resolved reasoning level for the active runtime. */
  reasoning?: AgentReasoning;
  /** Per-runtime reasoning overrides set by the user. */
  reasoningByRuntime?: Record<string, AgentReasoning>;
  hasRequiredKey: boolean;
}

export interface AgentModelInfo {
  id: string;
  label?: string;
  description?: string;
}

export interface VerifyProviderKeyResult {
  ok: boolean;
  provider?: string;
  model?: string;
  latencyMs?: number;
  error?: string;
}

export async function fetchAgentStatus(): Promise<AgentStatus> {
  const res = await fetch(`${API_BASE_URL}/agent/status`);
  if (!res.ok) throw new Error(`fetchAgentStatus failed: ${res.status}`);
  return res.json();
}

export type ReadyStatus = 'pending' | 'ready' | 'failed';

export interface ReadyResponse {
  status: ReadyStatus;
  error: string | null;
}

export async function fetchReady(): Promise<ReadyResponse> {
  const res = await fetch(`${API_BASE_URL}/ready`);
  if (!res.ok) throw new Error(`fetchReady failed: ${res.status}`);
  const body = await res.json();
  return {
    status:
      body.status === 'ready' || body.status === 'failed' ? body.status : 'pending',
    error: typeof body.error === 'string' ? body.error : null,
  };
}

export interface AgentOptionsPatch {
  runtime?: RuntimeId;
  provider?: string;
  model?: string;
  reasoning?: AgentReasoning;
}

export async function saveAgentOptions(
  patch: AgentOptionsPatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${API_BASE_URL}/agent/options`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export interface AgentModelsResponse {
  models: AgentModelInfo[];
  sanitizedModel: string | null;
}

export async function listAgentModels(opts?: { provider?: string }): Promise<AgentModelsResponse> {
  const url = new URL(`${API_BASE_URL}/agent/models`, window.location.href);
  if (opts?.provider) url.searchParams.set('provider', opts.provider);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`listAgentModels failed: ${res.status}`);
  const body = await res.json();
  return {
    models: Array.isArray(body.models) ? body.models : [],
    sanitizedModel: typeof body.sanitizedModel === 'string' ? body.sanitizedModel : null,
  };
}

export async function saveProviderKey(
  provider: string,
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${API_BASE_URL}/agent/provider-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function clearProviderKey(
  provider: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(
    `${API_BASE_URL}/agent/provider-key/${encodeURIComponent(provider)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    return { ok: false, error: body.error ?? `status ${res.status}` };
  }
  return res.json();
}

export async function verifyProviderKey(
  provider: string,
  opts?: { key?: string; model?: string },
): Promise<VerifyProviderKeyResult> {
  const res = await fetch(`${API_BASE_URL}/agent/provider-key/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key: opts?.key, model: opts?.model }),
  });
  const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
  if (!res.ok) return { ok: false, error: body.error ?? `status ${res.status}` };
  return body;
}

// ----- Artifact file reader -----

export interface ArtifactReadResult {
  content: string;
  path: string;
  basename: string;
  extension: string;
  size: number;
  modifiedAt: number;
}

export async function fetchArtifactContent(
  workspaceId: string,
  filePath: string,
): Promise<ArtifactReadResult> {
  const url = `${API_BASE_URL}/artifacts/${encodeURIComponent(workspaceId)}/read?path=${encodeURIComponent(filePath)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(body.error || `Failed to load artifact: ${res.status}`);
  }
  return res.json() as Promise<ArtifactReadResult>;
}
