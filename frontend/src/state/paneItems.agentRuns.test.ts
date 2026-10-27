import { describe, expect, it } from 'vitest';
import { agentRunPaneId, isPaneItem, paneItemTitle } from './paneItems';

describe('Agent Run pane items', () => {
  it('validates the durable composite identity', () => {
    const item = {
      id: agentRunPaneId('backend-a', 'run-1'),
      kind: 'agent-run',
      projectId: 'workspace-1',
      treeId: null,
      title: '',
      createdAt: 1,
      backendConnectionId: 'backend-a',
      runId: 'run-1',
    } as const;
    expect(isPaneItem(item)).toBe(true);
    expect(paneItemTitle(item)).toBe('Agent Run');
    expect(isPaneItem({ ...item, backendConnectionId: undefined })).toBe(false);
  });
});
