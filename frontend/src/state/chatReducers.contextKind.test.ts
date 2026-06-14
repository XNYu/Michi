import { describe, it, expect } from 'vitest';
import { reduceProject } from './chatReducers';
import type { Project } from './chatTypes';

const baseProject: Project = {
  id: 'p1',
  name: 'demo',
  cwd: '/tmp/demo',
  chatIds: [],
  edges: [],
  createdAt: 0,
  trees: [],
  activeTreeId: null,
  contexts: [],
};

describe('upsert-context with kind', () => {
  it('stamps kind: reference on a new entry when provided', () => {
    const next = reduceProject(baseProject, {
      type: 'upsert-context',
      projectId: 'p1',
      context: { name: 'doc', filePath: '/abs/path/doc.pdf', kind: 'reference' },
    });
    expect(next.contexts).toHaveLength(1);
    expect(next.contexts![0].kind).toBe('reference');
    expect(next.contexts![0].filePath).toBe('/abs/path/doc.pdf');
  });

  it('defaults to no kind (treated as embedded) when not provided', () => {
    const next = reduceProject(baseProject, {
      type: 'upsert-context',
      projectId: 'p1',
      context: { name: 'doc', filePath: '.contexts/doc.md' },
    });
    expect(next.contexts![0].kind).toBeUndefined();
  });

  it('preserves kind on update by id when caller omits it', () => {
    const seeded = reduceProject(baseProject, {
      type: 'upsert-context',
      projectId: 'p1',
      context: { name: 'doc', filePath: '/abs/doc.pdf', kind: 'reference' },
    });
    const id = seeded.contexts![0].id;
    const updated = reduceProject(seeded, {
      type: 'upsert-context',
      projectId: 'p1',
      context: { id, name: 'doc-renamed', filePath: '/abs/doc.pdf' },
    });
    expect(updated.contexts).toHaveLength(1);
    expect(updated.contexts![0].kind).toBe('reference');
    expect(updated.contexts![0].name).toBe('doc-renamed');
  });
});
