import { describe, expect, it } from 'vitest';
import { hydrateBackendWorkspaces } from './chatHydration';
import { isNodeUnread } from './sidebarSelectors';

describe('hydrateBackendWorkspaces — view marks', () => {
  it('keeps the stored view mark, and a node never viewed has none', () => {
    const state = hydrateBackendWorkspaces([{
      workspace: { id: 'ws1', name: 'Test', created_at: 1 },
      trees: [
        { id: 't1', root_node_id: 'seen', created_at: 1, last_active_at: 1 },
        { id: 't2', root_node_id: 'new', created_at: 2, last_active_at: 2 },
      ],
      nodes: [
        { id: 'seen', created_at: 1, kind: 'chat', viewed_at: 1_700_000_000_000, message_count: 2 },
        { id: 'new', created_at: 2, kind: 'chat', viewed_at: null, message_count: 2 },
      ],
      edges: [], messages: [], artifacts: [],
    }]);
    expect(state.nodes.seen.viewedAt).toBe(1_700_000_000_000);
    expect(state.nodes.new.viewedAt).toBeUndefined();
    const replied = { ...state.nodes.seen, lastAssistantAt: 1_700_000_000_001 };
    expect(isNodeUnread(replied, null)).toBe(true);
    expect(isNodeUnread({ ...replied, lastAssistantAt: 1_699_999_999_999 }, null)).toBe(false);
  });
});
