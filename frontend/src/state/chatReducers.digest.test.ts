import { describe, expect, it } from 'vitest';
import { reduceNodes } from './chatReducers';

function runningDigest() {
  const nodes = reduceNodes({}, { type: 'create-digest', nodeId: 'd1', projectId: 'p1', sources: ['s1'] });
  return reduceNodes(nodes, { type: 'digest-started', nodeId: 'd1' });
}

describe('digest generation activity', () => {
  it('discards activity on completion and ignores late activity events', () => {
    let nodes = reduceNodes(runningDigest(), { type: 'digest-thought', nodeId: 'd1', text: 'Temporary thoughts' });
    nodes = reduceNodes(nodes, { type: 'digest-generated', nodeId: 'd1', content: '# Result', sourceFingerprints: {}, generatedAt: 100 });
    expect(nodes.d1.digest?.generation).toBeUndefined();
    expect(nodes.d1.digest?.content).toBe('# Result');
    expect(reduceNodes(nodes, { type: 'digest-thought', nodeId: 'd1', text: 'Late' })).toBe(nodes);
    expect(reduceNodes(nodes, { type: 'digest-status', nodeId: 'd1', text: 'Late' })).toBe(nodes);
  });

  it('clears activity after failure and starts fresh on retry', () => {
    let nodes = reduceNodes(runningDigest(), { type: 'digest-thought', nodeId: 'd1', text: 'Old thoughts' });
    nodes = reduceNodes(nodes, { type: 'digest-error', nodeId: 'd1', message: 'Failed' });
    expect(nodes.d1.digest?.generation).toBeUndefined();
    nodes = reduceNodes(nodes, { type: 'digest-started', nodeId: 'd1' });
    expect(nodes.d1.digest?.generation?.thought).toBe('');
    expect(nodes.d1.digest?.error).toBeUndefined();
  });
});
