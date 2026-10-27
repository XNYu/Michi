import { expect, it } from 'vitest';
import { buildDigestPayload } from './digestPayload';
import { digestSourceSnapshot } from './digestSource';
import type { ChatNodeState, Project } from '../state/chatTypes';

const node = (id: string, title: string): ChatNodeState => ({ nodeId: id, projectId: 'p', kind: 'chat', chatId: null, title, status: 'idle', followUps: [], messages: [{ id: `${id}-u`, role: 'user', text: 'Question', toolCalls: [] }] });
it('uses the source tree root when refreshing a digest from an inactive tree', () => {
  const project: Project = { id: 'p', name: 'Workspace', activeTreeId: 'active', createdAt: 1, artifacts: [], chatIds: ['new-root', 'old-root', 'source'], trees: [{ id: 'active', rootNodeId: 'new-root', createdAt: 2, lastActiveAt: 2 }, { id: 'old', rootNodeId: 'old-root', createdAt: 1, lastActiveAt: 1 }], edges: [{ source: 'old-root', target: 'source', kind: 'branch' }] };
  const nodes = { 'new-root': node('new-root', 'New tree'), 'old-root': node('old-root', 'Old tree'), source: { ...node('source', 'Source title'), parentNodeId: 'old-root' } };
  const payload = buildDigestPayload(project, ['source'], nodes);
  expect(payload.rootTitle).toBe('Old tree');
  expect(payload.nodes).toEqual([digestSourceSnapshot(nodes.source)]);
});
