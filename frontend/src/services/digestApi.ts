import { backendApiBase } from '../config/backendConnections';
import { fetchStream } from './api/streamTransport';
import { readSseStream } from './api/sseParser';

export interface DigestGenerationPayload {
  workspace: { name: string; cwd?: string; createdAt: number };
  rootTitle: string;
  nodes: Array<{
    nodeId: string;
    parentNodeId?: string;
    title?: string;
    depth: number;
    messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  }>;
  cwd?: string;
  previousContent?: string;
  customPrompt?: string;
}

export interface StreamCallbacks {
  onChunk: (text: string) => void;
  onThought?: (text: string) => void;
  onStatus?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * Stream digest generation. `onChunk` fires for each incremental piece of
 * markdown; the resolved promise contains the final cleaned markdown
 * (scaffolding stripped) emitted with the `done` event.
 */
export async function streamDigest(
  payload: DigestGenerationPayload,
  { onChunk, onThought, onStatus, signal }: StreamCallbacks,
  connectionId?: string,
): Promise<string> {
  const res = await fetchStream(`${backendApiBase(connectionId)}/digests/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(err.error || `digest failed: ${res.status}`);
  }

  let finalMarkdown: string | null = null;
  let errorMessage: string | null = null;

  await readSseStream(res.body.getReader(), (event, data) => {
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (event === 'chunk' && typeof parsed?.text === 'string') {
      onChunk(parsed.text);
    } else if (event === 'thought' && typeof parsed?.text === 'string') {
      onThought?.(parsed.text);
    } else if (event === 'status' && typeof parsed?.text === 'string') {
      onStatus?.(parsed.text);
    } else if (event === 'done' && typeof parsed?.markdown === 'string') {
      finalMarkdown = parsed.markdown;
    } else if (event === 'error') {
      errorMessage = parsed?.message || 'digest streaming failed';
    }
  });

  if (errorMessage) throw new Error(errorMessage);
  if (finalMarkdown === null) throw new Error('digest stream ended without final markdown');
  return finalMarkdown;
}
