import { describe, expect, it, vi } from 'vitest';
import { fetchHomeConversations } from '../../../services/api/spacesHome';
import { workspaceConversations } from './taskConversations';

vi.mock('../../../services/api/spacesHome', () => ({ fetchHomeConversations: vi.fn() }));

describe('workspaceConversations', () => {
  it('offers the workspace’s newest conversations by the ids a Conversations cell holds', async () => {
    vi.mocked(fetchHomeConversations).mockResolvedValue({ total: 1, items: [{
      id: 'conversation:remote:host:n1', kind: 'conversation', workspaceId: 'remote:host:ws', workspaceName: 'W', title: 'Schema naming',
      at: 5, summary: '', agentClaim: false, state: 'waiting',
      target: { kind: 'conversation', nodeId: 'remote:host:n1', workspaceId: 'remote:host:ws', messageId: null },
    }] });
    expect(await workspaceConversations('host', 'remote:host:ws')).toEqual([{ nodeId: 'n1', title: 'Schema naming', state: 'waiting', at: 5 }]);
    expect(fetchHomeConversations).toHaveBeenCalledWith('host', { workspaceId: 'remote:host:ws', limit: 500 });
  });
});
