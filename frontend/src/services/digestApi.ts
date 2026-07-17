import { API_BASE_URL } from '../config/env';

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
  signal?: AbortSignal;
}

/**
 * Stream digest generation. `onChunk` fires for each incremental piece of
 * markdown; the resolved promise contains the final cleaned markdown
 * (scaffolding stripped) emitted with the `done` event.
 */
export async function streamDigest(
  payload: DigestGenerationPayload,
  { onChunk, signal }: StreamCallbacks,
): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/digests/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(err.error || `digest failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalMarkdown: string | null = null;
  let errorMessage: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      let dataLine = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLine += line.slice(6);
      }
      if (!dataLine) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(dataLine);
      } catch {
        continue;
      }
      if (event === 'chunk' && typeof parsed?.text === 'string') {
        onChunk(parsed.text);
      } else if (event === 'done' && typeof parsed?.markdown === 'string') {
        finalMarkdown = parsed.markdown;
      } else if (event === 'error') {
        errorMessage = parsed?.message || 'digest streaming failed';
      }
    }
  }

  if (errorMessage) throw new Error(errorMessage);
  if (finalMarkdown === null) throw new Error('digest stream ended without final markdown');
  return finalMarkdown;
}
