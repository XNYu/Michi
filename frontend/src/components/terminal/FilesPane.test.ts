import { describe, expect, it } from 'vitest';
import type { ArtifactEntry, Project } from '../../state/chatTypes';
import { resolveArtifactSelection, workspaceRoots } from './FilesPane';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Workspace',
    cwd: '/repo',
    folders: [{ id: 'f1', path: '/repo', addedAt: 1 }, { id: 'f2', path: '/shared', addedAt: 2 }],
    chatIds: [],
    edges: [],
    createdAt: 1,
    trees: [],
    activeTreeId: null,
    ...overrides,
  };
}

function artifact(overrides: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return {
    id: 'a1',
    name: 'notes',
    filePath: 'docs/notes.md',
    source: 'user',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('FilesPane helpers', () => {
  it('uses every registered workspace folder without duplicates', () => {
    expect(workspaceRoots(project({ folders: [
      { id: 'f1', path: '/repo/', addedAt: 1 },
      { id: 'f2', path: '/repo', addedAt: 2 },
      { id: 'f3', path: '/shared', addedAt: 3 },
    ] }))).toEqual(['/repo', '/shared']);
  });

  it('falls back to cwd for legacy projects', () => {
    expect(workspaceRoots(project({ folders: undefined }))).toEqual(['/repo']);
  });

  it('resolves workspace-relative and external artifact files', () => {
    expect(resolveArtifactSelection(artifact(), project())).toMatchObject({
      absolutePath: '/repo/docs/notes.md',
      artifactPath: 'docs/notes.md',
    });
    expect(resolveArtifactSelection(artifact({ filePath: '/tmp/reference.txt', kind: 'reference' }), project())).toEqual({
      id: 'artifact:a1',
      label: 'notes',
      absolutePath: '/tmp/reference.txt',
    });
  });

  it('omits link-only artifacts from the file tree', () => {
    expect(resolveArtifactSelection(artifact({ type: 'link', filePath: '', url: 'https://example.com' }), project())).toBeNull();
  });
});
