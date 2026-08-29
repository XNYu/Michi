import { beforeEach, describe, expect, it, vi } from 'vitest';
import { indexBackendProjects } from '../../config/backendConnections';
import {
  bindPendingPrimaryAgent,
  clearPendingPrimaryAgent,
  ensureSession,
  listPrimaryAgentDefinitions,
} from './sessions';

const definition = {
  version: 1, id: 'same-id', ownerUserId: 'owner', scope: 'workspace', workspaceId: 'remote-ws',
  name: 'Remote Agent', description: 'Remote.', instructions: 'Work.',
  runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [], toolRefs: [], skillRefs: [], mcpServerRefs: [],
  permissionPolicy: null, contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
    allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1000 }, defaultRunTtlMs: null,
  status: 'enabled', revision: 1, createdAt: 1, updatedAt: 1,
};

describe('primary Agent session API routing', () => {
  beforeEach(() => {
    indexBackendProjects([{ id: 'remote-ws', backendConnectionId: 'remote-a', chatIds: ['remote-node'] }]);
    clearPendingPrimaryAgent('remote-node');
    vi.restoreAllMocks();
  });

  it('discovers and binds through the Workspace owning Backend proxy', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ definitions: [definition] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ chatId: 'remote-node', currentModeId: null, resumeStrategy: 'fresh' }), { status: 200 }));
    const discovered = await listPrimaryAgentDefinitions('remote-ws');
    expect(discovered[0].backendConnectionId).toBe('remote-a');
    expect(fetchMock.mock.calls[0][0]).toContain('/backend-connections/remote-a/proxy/agents?');

    bindPendingPrimaryAgent('remote-node', {
      workspaceId: 'remote-ws', backendConnectionId: 'remote-a', definitionId: 'same-id',
    });
    await ensureSession({ nodeId: 'remote-node', workspaceId: 'remote-ws' });
    expect(fetchMock.mock.calls[1][0]).toContain('/backend-connections/remote-a/proxy/nodes/remote-node/ensure-session');
    const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(body.agentDefinitionId).toBe('same-id');
  });

  it('ordinary ensure-session requests remain unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ chatId: 'remote-node', currentModeId: null, resumeStrategy: 'fresh' }), { status: 200 }),
    );
    await ensureSession({ nodeId: 'remote-node', workspaceId: 'remote-ws' });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).not.toHaveProperty('agentDefinitionId');
  });

  it('rejects a same-ID Definition selected from another Backend', () => {
    expect(() => bindPendingPrimaryAgent('remote-node', {
      workspaceId: 'remote-ws', backendConnectionId: 'local', definitionId: 'same-id',
    })).toThrow(/different Backend/);
  });
});
