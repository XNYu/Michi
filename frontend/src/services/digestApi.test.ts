import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamDigest, type DigestGenerationPayload } from './digestApi';

const payload: DigestGenerationPayload = { workspace: { name: 'Test', createdAt: 1 }, rootTitle: 'Topic', nodes: [] };
function mockStream(events: Array<{ event: string; data: unknown }>) {
  const encoded = new TextEncoder().encode(events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
    start(controller) {
      // Fragment both SSE frames and UTF-8 sequences across network reads.
      for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));
      controller.close();
    },
  }))));
}

afterEach(() => vi.unstubAllGlobals());

describe('streamDigest', () => {
  it('delivers thoughts and status separately and returns only final markdown', async () => {
    mockStream([
      { event: 'status', data: { text: 'Preparing digest...' } },
      { event: 'thought', data: { text: '\u6bd4\u8f83\u6765\u6e90' } },
      { event: 'chunk', data: { text: '# Result' } },
      { event: 'done', data: { markdown: '# Clean result' } },
    ]);
    const onChunk = vi.fn();
    const onThought = vi.fn();
    const onStatus = vi.fn();
    expect(await streamDigest(payload, { onChunk, onThought, onStatus })).toBe('# Clean result');
    expect(onThought).toHaveBeenCalledExactlyOnceWith('\u6bd4\u8f83\u6765\u6e90');
    expect(onStatus).toHaveBeenCalledExactlyOnceWith('Preparing digest...');
    expect(onChunk).toHaveBeenCalledExactlyOnceWith('# Result');
  });

  it('rejects runtime errors after thoughts arrive', async () => {
    mockStream([{ event: 'thought', data: { text: 'Thinking' } }, { event: 'error', data: { message: 'Runtime failed' } }]);
    await expect(streamDigest(payload, { onChunk: vi.fn() })).rejects.toThrow('Runtime failed');
  });

  it('rejects a disconnected stream without treating partial output as complete', async () => {
    mockStream([{ event: 'chunk', data: { text: 'Partial' } }]);
    await expect(streamDigest(payload, { onChunk: vi.fn() })).rejects.toThrow('without final markdown');
  });
});
