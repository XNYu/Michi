import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeBackendApiBase,
  backendApiBase,
  indexBackendProjects,
  nodeBackendApiBase,
  getKnownBackendConnections,
  setKnownBackendConnections,
  setActiveBackendConnectionId,
  workspaceBackendApiBase,
} from './backendConnections';

describe('backend connection routing', () => {
  beforeEach(() => {
    indexBackendProjects([]);
    setActiveBackendConnectionId('local');
    setKnownBackendConnections([]);
  });

  it('keeps direct and SSH connections available alongside Local', () => {
    setKnownBackendConnections([
      {
        id: 'direct-1',
        name: 'Direct',
        transport: 'direct',
        apiUrl: 'https://michi.example.com/api',
        hasToken: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'ssh-1',
        name: 'SSH',
        transport: 'ssh',
        sshHost: 'build-server-box',
        remotePort: 3000,
        hasToken: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    expect(getKnownBackendConnections().map((connection) => [connection.id, connection.transport])).toEqual([
      ['local', 'direct'],
      ['direct-1', 'direct'],
      ['ssh-1', 'ssh'],
    ]);
  });

  it('keeps legacy requests on the local API by default', () => {
    expect(activeBackendApiBase()).not.toContain('/backend-connections/');
    expect(workspaceBackendApiBase('missing')).toBe(activeBackendApiBase());
  });

  it('routes workspace, node, and active backend requests through the local secure proxy', () => {
    indexBackendProjects([{ id: 'remote-ws', backendConnectionId: 'remote-1', chatIds: ['node-1'] }]);
    setActiveBackendConnectionId('remote-1');
    const expected = backendApiBase('remote-1');
    expect(expected).toContain('/backend-connections/remote-1/proxy');
    expect(workspaceBackendApiBase('remote-ws')).toBe(expected);
    expect(nodeBackendApiBase('node-1')).toBe(expected);
    expect(activeBackendApiBase()).toBe(expected);
  });
});
