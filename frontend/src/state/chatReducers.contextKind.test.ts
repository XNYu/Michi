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
  artifacts: [],
};

describe('upsert-context with kind', () => {
  it('stamps kind: reference on a new entry when provided', () => {
    const next = reduceProject(baseProject, {
      type: 'upsert-context',
      projectId: 'p1',
      context: { name: 'doc', filePath: '/abs/path/doc.pdf', kind: 'reference' },
    });
    expect(next.artifacts).toHaveLength(1);
    expect(next.artifacts![0].kind).toBe('reference');
    expect(next.artifacts![0].filePath).toBe('/abs/path/doc.pdf');
  });

  it('defaults to no kind (treated as embedded) when not provided', () => {
    const next = reduceProject(baseProject, {
      type: 'upsert-context',
      projectId: 'p1',
      context: { name: 'doc', filePath: '.artifacts/doc.md' },
    });
    expect(next.artifacts![0].kind).toBeUndefined();
  });

  it('preserves kind on update by id when caller omits it', () => {
    const seeded = reduceProject(baseProject, {
      type: 'upsert-context',
      projectId: 'p1',
      context: { name: 'doc', filePath: '/abs/doc.pdf', kind: 'reference' },
    });
    const id = seeded.artifacts![0].id;
    const updated = reduceProject(seeded, {
      type: 'upsert-context',
      projectId: 'p1',
      context: { id, name: 'doc-renamed', filePath: '/abs/doc.pdf' },
    });
    expect(updated.artifacts).toHaveLength(1);
    expect(updated.artifacts![0].kind).toBe('reference');
    expect(updated.artifacts![0].name).toBe('doc-renamed');
  });
});
