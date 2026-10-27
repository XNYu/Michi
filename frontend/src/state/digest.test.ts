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

  it('falls back gracefully for unstructured input', () => {
    const p = parseDigestStructure('Just some raw markdown with no format.');
    expect(p.tldr).toBeNull();
    expect(p.sections).toEqual([]);
    expect(p.openThreads).toEqual([]);
  });
});

describe('digest source DTO freshness', () => {
  const original = { ...mkChat('source', [{ role: 'user', text: 'Question' }, { role: 'assistant', text: 'Answer' }]), title: 'Title', parentNodeId: 'root' };
  const digest: DigestState = { sources: ['source'], sourceFingerprints: { source: computeSourceFingerprint(original) }, content: 'Saved', generatedAt: 1, viewedAt: 1, status: 'idle' };
  it.each([
    ['user text', { ...original, messages: [{ ...original.messages[0], text: 'Changed question' }, original.messages[1]] }],
    ['title', { ...original, title: 'Renamed' }],
    ['parent', { ...original, parentNodeId: 'other-root' }],
    ['deletion', { ...original, deletedAt: 10 }],
  ])('marks changed %s as stale', (_label, node) => {
    expect(staleSources(digest, { source: node })).toEqual(['source']);
  });
  it('ignores thoughts and empty messages excluded from the generation payload', () => {
    const node = { ...original, messages: [original.messages[0], { ...original.messages[1], blocks: [{ id: 'answer', kind: 'answer' as const, rawText: 'Answer' }, { id: 'thought', kind: 'thinking' as const, rawText: 'Transient analysis' }] }, { id: 'empty', role: 'user' as const, text: '', toolCalls: [] }] };
    expect(computeSourceFingerprint(node)).toBe(computeSourceFingerprint(original));
    expect(staleSources(digest, { source: node })).toEqual([]);
  });
});
