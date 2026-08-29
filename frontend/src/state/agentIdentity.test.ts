import { beforeEach, describe, expect, it } from 'vitest';
import {
  backendApiBase, indexBackendProjects, setActiveBackendConnectionId,
} from '../config/backendConnections';
import {
  agentResourceKey, backendConnectionIdFromApiBase, nodeAgentIdentity,
  parentAgentIndexKey, parseAgentResourceKey, workspaceAgentIdentity,
} from './agentIdentity';

describe('Agent composite identities', () => {
  beforeEach(() => {
    indexBackendProjects([
      { id: 'workspace-a', backendConnectionId: 'remote-a', chatIds: ['node-a'] },
      { id: 'workspace-b', backendConnectionId: 'remote-b', chatIds: ['node-b'] },
    ]);
    setActiveBackendConnectionId('local');
  });

  it('round-trips collision-safe backend/id tuples', () => {
    const identity = { backendConnectionId: 'remote::東京', id: 'run::same' };
    expect(parseAgentResourceKey(agentResourceKey(identity))).toEqual(identity);
    expect(parseAgentResourceKey('not-json')).toBeNull();
  });

  it('isolates equal resource IDs returned by different Backends', () => {
    const a = agentResourceKey({ backendConnectionId: 'remote-a', id: 'same-id' });
    const b = agentResourceKey({ backendConnectionId: 'remote-b', id: 'same-id' });
    expect(a).not.toBe(b);
    expect(parentAgentIndexKey('remote-a', 'message-1', null)).not.toBe(parentAgentIndexKey('remote-b', 'message-1', null));
  });

  it('derives workspace, node, and proxy connection identities', () => {
    expect(workspaceAgentIdentity('workspace-a', 'run-1').backendConnectionId).toBe('remote-a');
    expect(nodeAgentIdentity('node-b', 'run-1').backendConnectionId).toBe('remote-b');
    expect(backendConnectionIdFromApiBase(backendApiBase('remote-a'))).toBe('remote-a');
    expect(backendConnectionIdFromApiBase(backendApiBase('local'))).toBe('local');
  });
});
