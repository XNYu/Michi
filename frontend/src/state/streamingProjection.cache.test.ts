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

  it('recomputes when the last block identity changes (tail grew)', () => {
    const p1 = getRunProjection([ans('b0', 'Hello')], undefined);
    const p2 = getRunProjection([ans('b0', 'Hello world')], undefined); // new tail object
    expect(p2).not.toBe(p1);
    expect(p2.visibleText).toBe('Hello world');
  });

  it('recomputes when incomingCarry changes for the same last block', () => {
    const block = ans('b0', 'world');
    const p1 = getRunProjection([block], undefined);
    const p2 = getRunProjection([block], { pendingRawTail: '[FOLL' });
    expect(p2).not.toBe(p1);
  });

  it('recomputes a downstream run when the upstream carry changes, even if its last block is unchanged', () => {
    const tail = ans('d0', ' Hidden]');
    const downstream = [tail];

    // `[TITLE:` (no closing `]`) is an unresolved sentinel prefix, so the
    // upstream run holds it out of visibleText and emits it as outgoingCarry.
    const up1 = getRunProjection([ans('u0', 'text [TITLE:')], undefined);
    const p1 = getRunProjection(downstream, up1.outgoingCarry);

    const up2 = getRunProjection([ans('u0', 'text [TITLE: more')], undefined); // new upstream last block
    const p2 = getRunProjection(downstream, up2.outgoingCarry);

    // Guard against a vacuous test: the upstream carry must genuinely differ.
    expect(up1.outgoingCarry).toEqual({ pendingRawTail: '[TITLE:' });
    expect(up2.outgoingCarry).toEqual({ pendingRawTail: '[TITLE: more' });
    expect(up2.outgoingCarry).not.toEqual(up1.outgoingCarry);

    expect(p2).not.toBe(p1); // same downstream last block, but carry changed → recompute
  });
});
