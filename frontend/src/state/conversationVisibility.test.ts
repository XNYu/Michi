import { describe, expect, it } from 'vitest';
import { mapNodeRowScalars } from './chatHydration';
import { isVisibleConversationNode } from './conversationVisibility';
import { serializeNodeRow } from './workspacePersistence';
import type { ChatNodeState, Project } from './chatTypes';

describe('page helper visibility metadata', () => {
  it('hydrates server page binding and keeps it out of ordinary surfaces until promotion', () => {
    const helper = mapNodeRowScalars({ id: 'helper-node', page_id: 'native-page' });
    expect(helper.pageId).toBe('native-page');
    expect(isVisibleConversationNode(helper)).toBe(false);
    expect(isVisibleConversationNode({ pageId: null })).toBe(true);
    expect(isVisibleConversationNode({})).toBe(true);
  });

  it('does not send page binding metadata back in stale workspace sync rows', () => {
    const project: Project = { id: 'workspace', name: 'Workspace', chatIds: ['helper'], trees: [], edges: [], activeTreeId: null, createdAt: 1 };
    const helper = { nodeId: 'helper', projectId: 'workspace', kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle', pageId: 'page-1' } as ChatNodeState;
    const row = serializeNodeRow(project, { helper }, 'helper');
    expect(row).not.toHaveProperty('page_id');
    expect(row).not.toHaveProperty('pageId');
  });
});

describe('Meta agent maintenance transcripts', () => {
  it('hydrate their job marker and stay out of ordinary surfaces', () => {
    const run = mapNodeRowScalars({ id: 'run-node', maintenance_job_id: 'job-maint' });
    expect(run.maintenanceJobId).toBe('job-maint');
    expect(isVisibleConversationNode(run)).toBe(false);
    expect(isVisibleConversationNode(mapNodeRowScalars({ id: 'user-node' }))).toBe(true);
  });

  it('do not send the marker back in workspace sync rows', () => {
    const project: Project = { id: 'workspace', name: 'Workspace', chatIds: ['run'], trees: [], edges: [], activeTreeId: null, createdAt: 1 };
    const run = { nodeId: 'run', projectId: 'workspace', kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle', maintenanceJobId: 'job-maint' } as ChatNodeState;
    const row = serializeNodeRow(project, { run }, 'run');
    expect(row).not.toHaveProperty('maintenance_job_id');
    expect(row).not.toHaveProperty('maintenanceJobId');
  });
});
