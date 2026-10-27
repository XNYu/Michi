import { describe, expect, it } from 'vitest';
import { isPaneItem, normalizeBrowserUrl, pagePaneId } from './paneItems';

describe('pane items', () => {
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

  it('validates page owner identity separately from the required host slot and scopes stable identity', () => {
    const item = {
      id: pagePaneId('backend-a', 'owner-ws', 'page-1'), kind: 'page',
      projectId: 'host-ws', treeId: 'host-tree', title: 'Roadmap', createdAt: 1,
      backendConnectionId: 'backend-a', workspaceId: 'owner-ws', pageId: 'page-1',
    } as const;
    expect(isPaneItem(item)).toBe(true);
    expect(isPaneItem({ ...item, projectId: undefined })).toBe(false);
    expect(isPaneItem({ ...item, workspaceId: undefined })).toBe(false);
    expect(isPaneItem({ ...item, id: 'pane:page:other' })).toBe(false);
    expect(pagePaneId('backend-a', 'owner-ws', 'page-1')).not.toBe(pagePaneId('backend-b', 'owner-ws', 'page-1'));
    expect(pagePaneId('backend-a', 'owner-ws', 'page-1')).not.toBe(pagePaneId('backend-a', 'other-ws', 'page-1'));
    expect(pagePaneId('backend-a', 'owner-ws', 'page-1')).not.toBe(pagePaneId('backend-a', 'owner-ws', 'page-2'));
  });
});

it('restores legacy file descriptors and validates optional origin chats', () => {
  const item = { id: 'file', kind: 'file', projectId: 'p', treeId: 't', title: 'a', createdAt: 1, filePath: 'a', viewMode: 'source' };
  expect(isPaneItem(item)).toBe(true);
  expect(isPaneItem({ ...item, originChatNodeId: 'n' })).toBe(true);
  expect(isPaneItem({ ...item, originChatNodeId: 3 })).toBe(false);
});
