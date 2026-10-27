import { getRunProjection } from './streamingProjection';
import type { AssistantBlock } from './chatTypes';

const ans = (id: string, rawText: string): AssistantBlock =>
  ({ id, kind: 'answer', rawText, streaming: true });

describe('getRunProjection cache', () => {
  it('returns the same projection object for the same last block + carry', () => {
    const blocks = [ans('b0', 'Hello world')];
    const p1 = getRunProjection(blocks, undefined);
    const p2 = getRunProjection(blocks, undefined);
    expect(p2).toBe(p1);                       // cache hit
    expect(p1.visibleText).toBe('Hello world');
  });
});
