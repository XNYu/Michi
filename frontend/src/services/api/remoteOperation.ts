import type { RemoteConnectionDiagnostic } from 'michi-shared';
import { API_BASE_URL } from '../../config/env';

export class RemoteConnectionFailure extends Error {
  constructor(message: string, readonly diagnostic: RemoteConnectionDiagnostic) { super(message); }
}

export async function fetchRemoteDiagnostic(id: string): Promise<RemoteConnectionDiagnostic> {
  const response = await fetch(`${API_BASE_URL}/backend-connections/diagnostics/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Saved diagnostic is unavailable (' + response.status + ').');
  return response.json();
}

export async function streamRemoteOperation<T>(
  endpoint: string, input: unknown, host: string, onProgress: (message: string) => void, signal?: AbortSignal,
  onStage?: (stage: string) => void,
): Promise<T> {
  const local: RemoteConnectionDiagnostic = { id: 'client-' + crypto.randomUUID(), host, startedAt: new Date().toISOString(), stage: 'request', log: '', truncated: false };
  let attemptId: string | undefined;
  let result: T | undefined;
  try {
    const response = await fetch(`${API_BASE_URL}/backend-connections/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input), signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || 'Could not start the remote operation (HTTP ' + response.status + ').');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'attempt') { attemptId = event.id; local.id = event.id; }
      if (event.type === 'progress') {
        local.stage = event.stage ?? local.stage;
        local.log += new Date().toISOString() + ' [' + local.stage + '] ' + event.message + '\n';
        onStage?.(local.stage); onProgress(event.message);
      }
      if (event.type === 'error') {
        local.code = event.code;
        throw new RemoteConnectionFailure(event.message, event.diagnostic ?? { ...local, message: event.message });
      }
      if (event.type === 'result') result = event.result;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) consume(line);
        if (done) { consume(pending); break; }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!result) throw new Error('The remote operation ended before it completed. Check its status before trying again.');
    return result;
  } catch (error) {
    if (signal?.aborted || error instanceof RemoteConnectionFailure) throw error;
    const message = error instanceof Error ? error.message : String(error);
    local.code = 'connection_interrupted'; local.message = message;
    local.log += '[client] ' + message + '\n';
    if (attemptId) {
      try {
        const saved = await fetchRemoteDiagnostic(attemptId);
        saved.log += '\n[client] ' + message;
        throw new RemoteConnectionFailure(saved.severity === 'error' ? saved.message ?? message : message, saved);
      } catch (retrievalError) {
        if (retrievalError instanceof RemoteConnectionFailure) throw retrievalError;
        local.log += '[diagnostic retrieval] ' + String(retrievalError);
      }
    }
    throw new RemoteConnectionFailure(message, local);
  }
}
