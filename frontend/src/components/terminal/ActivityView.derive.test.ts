import { describe, expect, it } from 'vitest';
import { deriveActivityData } from './ActivityView';
import type { ChatNodeState, Project } from '../../state/chatTypes';

const node = (nodeId: string, extra: Partial<ChatNodeState> = {}) => ({
  nodeId, chatId: null, projectId: 'p1', kind: 'chat', messages: [], followUps: [], status: 'idle', ...extra,
}) as ChatNodeState;

describe('deriveActivityData', () => {
  it('lists the user’s threads but not Meta agent maintenance runs or page helpers', () => {
    const project: Project = {
      id: 'p1', name: 'One', createdAt: 0, activeTreeId: 't-user', chatIds: ['user', 'run', 'helper'], edges: [],
      trees: [
        { id: 't-user', rootNodeId: 'user', createdAt: 0, lastActiveAt: 10 },
        { id: 't-run', rootNodeId: 'run', createdAt: 0, lastActiveAt: 30 },
        { id: 't-helper', rootNodeId: 'helper', createdAt: 0, lastActiveAt: 20 },
      ],
    };
    const nodes = { user: node('user'), run: node('run', { maintenanceJobId: 'job-maint' }), helper: node('helper', { pageId: 'page-1' }) };
    expect(deriveActivityData([project], nodes).map((item) => item.tree.id)).toEqual(['t-user']);
  });
});
