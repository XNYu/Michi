import { beforeEach, describe, expect, it } from 'vitest';
import { indexBackendProjects, getKnownBackendConnections, setKnownBackendConnections, setActiveBackendConnectionId } from './backendConnections';

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
});
