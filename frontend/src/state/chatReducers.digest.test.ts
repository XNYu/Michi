import { describe, expect, it } from 'vitest';
import { reduceNodes } from './chatReducers';
import { serializeNodeRow, writeScopedLocalStorage, stateProjectKey } from './workspacePersistence';
import type { Project } from './chatTypes';

function runningDigest() {
  const nodes = reduceNodes({}, { type: 'create-digest', nodeId: 'd1', projectId: 'p1', sources: ['s1'] });
  return reduceNodes(nodes, { type: 'digest-started', nodeId: 'd1' });
}

describe('digest generation activity', () => {
  it('keeps thought deltas separate from markdown and updates activity', () => {
    let nodes = runningDigest();
    nodes = reduceNodes(nodes, { type: 'digest-thought', nodeId: 'd1', text: 'Compare ' });
    nodes = reduceNodes(nodes, { type: 'digest-thought', nodeId: 'd1', text: 'sources' });
    expect(nodes.d1.digest?.content).toBe('');
    expect(nodes.d1.digest?.generation).toMatchObject({ thought: 'Compare sources', activity: 'Thinking...' });
    nodes = reduceNodes(nodes, { type: 'digest-status', nodeId: 'd1', text: 'Reading notes' });
    expect(nodes.d1.digest?.generation?.activity).toBe('Reading notes');
    nodes = reduceNodes(nodes, { type: 'digest-chunk', nodeId: 'd1', text: '# Result' });
    expect(nodes.d1.digest?.content).toBe('# Result');
    expect(nodes.d1.digest?.generation?.activity).toBe('Writing digest...');
  });

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

  it('does not persist activity to SQLite or the legacy fallback cache', () => {
    const project: Project = {
      id: 'p1', name: 'Workspace', chatIds: ['d1'], edges: [], trees: [], activeTreeId: null, artifacts: [], createdAt: 1,
    };
    let nodes = reduceNodes(runningDigest(), { type: 'digest-thought', nodeId: 'd1', text: 'Temporary thoughts' });
    nodes = reduceNodes(nodes, { type: 'digest-set-prompt', nodeId: 'd1', customPrompt: 'Focus on decisions' });
    const persisted = JSON.parse(serializeNodeRow(project, nodes, 'd1')!.digest!);
    expect(persisted.generation).toBeUndefined();
    expect(persisted.customPrompt).toBe('Focus on decisions');
    const baseKey = 'michi:digest-test';
    writeScopedLocalStorage({ baseKey, projects: [project], nodes, activeProjectId: 'p1', changedIds: new Set(['p1']), indexDirty: true });
    const cached = JSON.parse(localStorage.getItem(stateProjectKey(baseKey, 'p1'))!);
    expect(cached.nodes.d1.digest.generation).toBeUndefined();
    expect(nodes.d1.digest?.generation?.thought).toBe('Temporary thoughts');
  });
});
