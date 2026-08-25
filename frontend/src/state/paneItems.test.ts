import { describe, expect, it, vi } from 'vitest';
import { isPaneItem, normalizeBrowserUrl, singletonPaneId, uniquePaneId } from './paneItems';

describe('pane items', () => {
  it('creates stable singleton ids scoped by project and path', () => {
    expect(singletonPaneId('file', 'p1', 'docs/a.md')).toBe(singletonPaneId('file', 'p1', 'docs/a.md'));
    expect(singletonPaneId('file', 'p1', 'docs/a.md')).not.toBe(singletonPaneId('diff', 'p1', 'docs/a.md'));
    expect(singletonPaneId('file', 'p1', 'docs/a.md')).not.toBe(singletonPaneId('file', 'p2', 'docs/a.md'));
  });

  it('creates a fresh id for runtime-backed surfaces', () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002');
    expect(uniquePaneId('terminal')).not.toBe(uniquePaneId('terminal'));
    randomUUID.mockRestore();
  });

  it('accepts only complete serializable descriptors', () => {
    expect(isPaneItem({
      id: 'pane:launcher:1', kind: 'launcher', projectId: 'p1', treeId: 't1', title: 'New pane', createdAt: 1,
      anchorNodeId: 'n1',
    })).toBe(true);
    expect(isPaneItem({
      id: 'pane:files:1', kind: 'files', projectId: 'p1', treeId: 't1', title: 'Files', createdAt: 1,
    })).toBe(true);
    expect(isPaneItem({
      id: 'pane:review:1', kind: 'review', projectId: 'p1', treeId: 't1', title: 'Review', createdAt: 1,
    })).toBe(true);
    expect(isPaneItem({
      id: 'pane:file:1', kind: 'file', projectId: 'p1', treeId: 't1', title: 'a.md', createdAt: 1,
      filePath: 'a.md', viewMode: 'rendered',
    })).toBe(true);
    expect(isPaneItem({ id: 'pane:terminal:1', kind: 'terminal', projectId: 'p1', treeId: 't1', title: 'Terminal', createdAt: 1 })).toBe(false);
    expect(isPaneItem({ id: 'pane:launcher:1', kind: 'launcher', projectId: 'p1', treeId: 't1', title: 'New pane', createdAt: 1, anchorNodeId: 42 })).toBe(false);
    expect(isPaneItem({ id: 'pane:file:1', kind: 'unknown', projectId: 'p1', treeId: 't1', title: '', createdAt: 1 })).toBe(false);
  });

  it('normalizes host-like input and rejects privileged protocols', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com/');
    expect(normalizeBrowserUrl('http://localhost:3000/a')).toBe('http://localhost:3000/a');
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeBrowserUrl('javascript:alert(1)')).toBeNull();
  });
});
