import { describe, it, expect, beforeEach } from 'vitest';
import {
  STATE_KEY_PREFIX,
  LEGACY_STATE_KEY,
  buildStateKey,
  stateIndexKey,
  stateProjectKey,
  readLocalStoragePayload,
  readLocalStorageState,
  writeScopedLocalStorage,
} from './workspacePersistence';
import { STATE_SCHEMA_VERSION } from './chatHydration';

const mkProject = (id: string, chatIds: string[]): any => ({
  id,
  name: id,
  cwd: undefined,
  chatIds,
  edges: [],
  trees: [{ id: `t-${id}`, rootNodeId: chatIds[0], createdAt: 1, lastActiveAt: 1 }],
  activeTreeId: `t-${id}`,
  contexts: [],
  createdAt: 1,
});

const mkNode = (nodeId: string, projectId: string): any => ({
  nodeId,
  projectId,
  kind: 'chat',
  messages: [],
  followUps: [],
  status: 'idle',
});

beforeEach(() => {
  localStorage.clear();
});

describe('per-project key derivation', () => {
  it('derives index/project keys under STATE_KEY_PREFIX so signOut cleanup covers them', () => {
    const base = buildStateKey('user1'); // michi:v1:state:user1
    expect(stateIndexKey(base)).toBe('michi:v1:state:user1:index');
    expect(stateProjectKey(base, 'pA')).toBe('michi:v1:state:user1:p:pA');
    expect(stateIndexKey(base).startsWith(STATE_KEY_PREFIX)).toBe(true);
    expect(stateProjectKey(base, 'pA').startsWith(STATE_KEY_PREFIX)).toBe(true);

    // Legacy base (no userId) also lands under the prefix.
    expect(stateIndexKey(LEGACY_STATE_KEY)).toBe('michi:v1:state:index');
    expect(stateIndexKey(LEGACY_STATE_KEY).startsWith(STATE_KEY_PREFIX)).toBe(true);
  });
});

describe('readLocalStoragePayload', () => {
  it('reassembles the raw SavedState from the per-project layout', () => {
    const base = buildStateKey('user1');
    localStorage.setItem(
      stateIndexKey(base),
      JSON.stringify({ version: STATE_SCHEMA_VERSION, activeProjectId: 'pA', projectIds: ['pA', 'pB'] }),
    );
    localStorage.setItem(
      stateProjectKey(base, 'pA'),
      JSON.stringify({ project: mkProject('pA', ['n1']), nodes: { n1: mkNode('n1', 'pA') } }),
    );
    localStorage.setItem(
      stateProjectKey(base, 'pB'),
      JSON.stringify({ project: mkProject('pB', ['n2']), nodes: { n2: mkNode('n2', 'pB') } }),
    );

    const payload = readLocalStoragePayload('user1')!;
    expect(payload.version).toBe(STATE_SCHEMA_VERSION);
    expect(payload.activeProjectId).toBe('pA');
    expect(payload.projects.map((p: any) => p.id)).toEqual(['pA', 'pB']);
    expect(Object.keys(payload.nodes).sort()).toEqual(['n1', 'n2']);
  });

  it('falls back to the legacy single-key layout when no index exists', () => {
    const base = buildStateKey('user1');
    const saved = {
      version: STATE_SCHEMA_VERSION,
      projects: [mkProject('pA', ['n1'])],
      activeProjectId: 'pA',
      nodes: { n1: mkNode('n1', 'pA') },
    };
    localStorage.setItem(base, JSON.stringify(saved));
    const payload = readLocalStoragePayload('user1')!;
    expect(payload.projects.map((p: any) => p.id)).toEqual(['pA']);
  });

  it('tolerates an index that references a missing project blob', () => {
    const base = buildStateKey('user1');
    localStorage.setItem(
      stateIndexKey(base),
      JSON.stringify({ version: STATE_SCHEMA_VERSION, activeProjectId: 'pA', projectIds: ['pA', 'pB'] }),
    );
    localStorage.setItem(
      stateProjectKey(base, 'pA'),
      JSON.stringify({ project: mkProject('pA', ['n1']), nodes: { n1: mkNode('n1', 'pA') } }),
    );
    // pB blob intentionally absent.
    const payload = readLocalStoragePayload('user1')!;
    expect(payload.projects.map((p: any) => p.id)).toEqual(['pA']); // pB skipped, no crash
  });

  it('tolerates a corrupt (malformed JSON) project blob', () => {
    const base = buildStateKey('user1');
    localStorage.setItem(
      stateIndexKey(base),
      JSON.stringify({ version: STATE_SCHEMA_VERSION, activeProjectId: 'pA', projectIds: ['pA', 'pB'] }),
    );
    localStorage.setItem(
      stateProjectKey(base, 'pA'),
      JSON.stringify({ project: mkProject('pA', ['n1']), nodes: { n1: mkNode('n1', 'pA') } }),
    );
    localStorage.setItem(stateProjectKey(base, 'pB'), '{not valid json');
    const payload = readLocalStoragePayload('user1')!;
    expect(payload.projects.map((p: any) => p.id)).toEqual(['pA']); // pB dropped, no throw, no legacy fallback
  });

  it('returns null when nothing is stored', () => {
    expect(readLocalStoragePayload('user1')).toBeNull();
  });
});

describe('readLocalStorageState (hydrated)', () => {
  it('hydrates the per-project layout into live state', () => {
    const base = buildStateKey('user1');
    localStorage.setItem(
      stateIndexKey(base),
      JSON.stringify({ version: STATE_SCHEMA_VERSION, activeProjectId: 'pA', projectIds: ['pA'] }),
    );
    localStorage.setItem(
      stateProjectKey(base, 'pA'),
      JSON.stringify({ project: mkProject('pA', ['n1']), nodes: { n1: mkNode('n1', 'pA') } }),
    );
    const hydrated = readLocalStorageState('user1');
    expect(hydrated.projects.map((p: any) => p.id)).toEqual(['pA']);
    expect(hydrated.activeProjectId).toBe('pA');
    expect(Object.keys(hydrated.nodes)).toEqual(['n1']);
  });

  it('returns empty state when nothing is stored', () => {
    const hydrated = readLocalStorageState('user1');
    expect(hydrated.projects).toEqual([]);
    expect(hydrated.activeProjectId).toBeNull();
    expect(hydrated.nodes).toEqual({});
  });
});

describe('writeScopedLocalStorage', () => {
  it('seeds ALL projects + index on the first write and drops the legacy single key', () => {
    const base = buildStateKey('user1');
    // Legacy single-key blob present from the old layout.
    localStorage.setItem(
      base,
      JSON.stringify({ version: STATE_SCHEMA_VERSION, projects: [], activeProjectId: null, nodes: {} }),
    );
    const projects = [mkProject('pA', ['n1']), mkProject('pB', ['n2'])];
    const nodes = { n1: mkNode('n1', 'pA'), n2: mkNode('n2', 'pB') };

    // Only pA is "changed", but seeding must persist BOTH.
    writeScopedLocalStorage({
      baseKey: base, projects, activeProjectId: 'pA', nodes,
      changedIds: new Set(['pA']), indexDirty: false,
    });

    expect(localStorage.getItem(stateProjectKey(base, 'pA'))).toBeTruthy();
    expect(localStorage.getItem(stateProjectKey(base, 'pB'))).toBeTruthy();
    const idx = JSON.parse(localStorage.getItem(stateIndexKey(base))!);
    expect(idx.projectIds).toEqual(['pA', 'pB']);
    expect(idx.activeProjectId).toBe('pA');
    expect(localStorage.getItem(base)).toBeNull(); // legacy single key reclaimed
  });

  it('only rewrites changed project blobs after seeding', () => {
    const base = buildStateKey('user1');
    const projects = [mkProject('pA', ['n1']), mkProject('pB', ['n2'])];
    const nodes = { n1: mkNode('n1', 'pA'), n2: mkNode('n2', 'pB') };
    writeScopedLocalStorage({
      baseKey: base, projects, activeProjectId: 'pA', nodes,
      changedIds: new Set(['pA', 'pB']), indexDirty: true,
    }); // seed
    const beforeB = localStorage.getItem(stateProjectKey(base, 'pB'));

    const nodes2 = { ...nodes, n1: { ...nodes.n1, title: 'changed' } };
    writeScopedLocalStorage({
      baseKey: base, projects, activeProjectId: 'pA', nodes: nodes2,
      changedIds: new Set(['pA']), indexDirty: false,
    });

    expect(JSON.parse(localStorage.getItem(stateProjectKey(base, 'pA'))!).nodes.n1.title).toBe('changed');
    expect(localStorage.getItem(stateProjectKey(base, 'pB'))).toBe(beforeB); // untouched
  });

  it('removes the blob for a deleted project and prunes it from the index', () => {
    const base = buildStateKey('user1');
    const projects = [mkProject('pA', ['n1']), mkProject('pB', ['n2'])];
    const nodes = { n1: mkNode('n1', 'pA'), n2: mkNode('n2', 'pB') };
    writeScopedLocalStorage({
      baseKey: base, projects, activeProjectId: 'pA', nodes,
      changedIds: new Set(['pA', 'pB']), indexDirty: true,
    }); // seed

    const projects2 = [mkProject('pA', ['n1'])]; // pB removed
    writeScopedLocalStorage({
      baseKey: base, projects: projects2, activeProjectId: 'pA', nodes,
      changedIds: new Set(['pB']), indexDirty: true,
    });

    expect(localStorage.getItem(stateProjectKey(base, 'pB'))).toBeNull();
    expect(JSON.parse(localStorage.getItem(stateIndexKey(base))!).projectIds).toEqual(['pA']);
  });

  it('active-project-only change updates the index without rewriting project blobs', () => {
    const base = buildStateKey('user1');
    const projects = [mkProject('pA', ['n1']), mkProject('pB', ['n2'])];
    const nodes = { n1: mkNode('n1', 'pA'), n2: mkNode('n2', 'pB') };
    writeScopedLocalStorage({
      baseKey: base, projects, activeProjectId: 'pA', nodes,
      changedIds: new Set(['pA', 'pB']), indexDirty: true,
    }); // seed
    const blobA = localStorage.getItem(stateProjectKey(base, 'pA'));
    const blobB = localStorage.getItem(stateProjectKey(base, 'pB'));

    writeScopedLocalStorage({
      baseKey: base, projects, activeProjectId: 'pB', nodes,
      changedIds: new Set(), indexDirty: true,
    });

    expect(localStorage.getItem(stateProjectKey(base, 'pA'))).toBe(blobA); // untouched
    expect(localStorage.getItem(stateProjectKey(base, 'pB'))).toBe(blobB); // untouched
    expect(JSON.parse(localStorage.getItem(stateIndexKey(base))!).activeProjectId).toBe('pB');
  });

  it('round-trips: writeScoped then readLocalStoragePayload returns equivalent raw state', () => {
    const base = buildStateKey('user1');
    const projects = [mkProject('pA', ['n1']), mkProject('pB', ['n2'])];
    const nodes = { n1: mkNode('n1', 'pA'), n2: mkNode('n2', 'pB') };
    writeScopedLocalStorage({
      baseKey: base, projects, activeProjectId: 'pA', nodes,
      changedIds: new Set(['pA', 'pB']), indexDirty: true,
    });
    const payload = readLocalStoragePayload('user1')!;
    expect(payload.activeProjectId).toBe('pA');
    expect(payload.projects.map((p: any) => p.id)).toEqual(['pA', 'pB']);
    expect(Object.keys(payload.nodes).sort()).toEqual(['n1', 'n2']);
  });
});
