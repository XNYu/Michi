import { computeSourceFingerprint, staleSources, parseDigestStructure, DigestState } from './digest';
import { ChatNodeState } from './chatTypes';

const mkChat = (id: string, messages: Array<{ role: 'user' | 'assistant'; text: string }>): ChatNodeState => ({
  nodeId: id,
  kind: 'chat',
  chatId: null,
  projectId: 'p',
  messages: messages.map((m, i) => ({ id: `${id}-${i}`, role: m.role, text: m.text, toolCalls: [] })),
  followUps: [],
  status: 'idle',
});

describe('computeSourceFingerprint', () => {
  it('returns stable string for identical assistant trail', () => {
    const a = mkChat('n', [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);
    const b = mkChat('n', [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);
    expect(computeSourceFingerprint(a)).toBe(computeSourceFingerprint(b));
  });

  it('changes when a new assistant message is added', () => {
    const before = mkChat('n', [{ role: 'assistant', text: 'hello' }]);
    const after = mkChat('n', [
      { role: 'assistant', text: 'hello' },
      { role: 'assistant', text: 'more' },
    ]);
    expect(computeSourceFingerprint(before)).not.toBe(computeSourceFingerprint(after));
  });

  it('ignores user messages (only assistant trail matters)', () => {
    // Digests summarize what kiro said, not what the user typed.
    const a = mkChat('n', [
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'reply' },
    ]);
    const b = mkChat('n', [
      { role: 'user', text: 'two' },
      { role: 'assistant', text: 'reply' },
    ]);
    expect(computeSourceFingerprint(a)).toBe(computeSourceFingerprint(b));
  });
});

describe('staleSources', () => {
  const digest: DigestState = {
    sources: ['s1', 's2'],
    sourceFingerprints: { s1: 'fp-old', s2: 'fp-same' },
    content: 'old digest',
    generatedAt: 0,
    viewedAt: 0,
    status: 'idle',
  };

  it('returns source ids whose fingerprint changed', () => {
    const nodes = {
      s1: mkChat('s1', [{ role: 'assistant', text: 'NEW' }]),
      s2: mkChat('s2', [{ role: 'assistant', text: 'SAME' }]),
    };
    // Pretend fp-same matches s2's current fingerprint
    const digestWith: DigestState = {
      ...digest,
      sourceFingerprints: {
        s1: 'fp-definitely-different',
        s2: computeSourceFingerprint(nodes.s2),
      },
    };
    const stale = staleSources(digestWith, nodes);
    expect(stale).toContain('s1');
    expect(stale).not.toContain('s2');
  });

  it('reports a deleted source as stale', () => {
    const nodes = {}; // s1 and s2 both gone
    const stale = staleSources(digest, nodes);
    expect(stale).toEqual(['s1', 's2']);
  });
});

describe('parseDigestStructure', () => {
  const sample = `TL;DR: Scaled dot-product attention divides by √dₖ to keep pre-softmax variance constant.

## §01 Why √dₖ
source: n3

Variance of q·k scales with dₖ; √dₖ restores unit variance.

## §02 Variance derivation
source: n4

Var(q·k) = dₖ by independence of q_i, k_i.

Open Threads:
- Does √dₖ hold at dₖ > 256?
- Interaction with positional encoding?
`;

  it('extracts the TL;DR paragraph', () => {
    const p = parseDigestStructure(sample);
    expect(p.tldr).toMatch(/^Scaled dot-product/);
  });

  it('splits into two sections', () => {
    const p = parseDigestStructure(sample);
    expect(p.sections).toHaveLength(2);
    expect(p.sections[0]).toEqual({
      title: 'Why √dₖ',
      sourceId: 'n3',
      body: expect.stringContaining('Variance of q·k'),
    });
    expect(p.sections[1].sourceId).toBe('n4');
  });

  it('extracts open threads bullets', () => {
    const p = parseDigestStructure(sample);
    expect(p.openThreads).toEqual([
      'Does √dₖ hold at dₖ > 256?',
      'Interaction with positional encoding?',
    ]);
  });

  it('falls back gracefully for unstructured input', () => {
    const p = parseDigestStructure('Just some raw markdown with no format.');
    expect(p.tldr).toBeNull();
    expect(p.sections).toEqual([]);
    expect(p.openThreads).toEqual([]);
  });
});
