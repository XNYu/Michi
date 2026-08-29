import {
  LOCAL_BACKEND_CONNECTION_ID,
  backendConnectionIdForNode,
  backendConnectionIdForWorkspace,
} from '../config/backendConnections';

export interface AgentResourceIdentity {
  backendConnectionId: string;
  id: string;
}

export interface LocatedAgentResource<T> {
  backendConnectionId: string;
  value: T;
}

export function agentResourceKey(identity: AgentResourceIdentity): string {
  return JSON.stringify([identity.backendConnectionId, identity.id]);
}

export function parseAgentResourceKey(key: string): AgentResourceIdentity | null {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [backendConnectionId, id] = value;
    if (typeof backendConnectionId !== 'string' || !backendConnectionId || typeof id !== 'string' || !id) return null;
    return { backendConnectionId, id };
  } catch {
    return null;
  }
}

export function locatedAgentResource<T>(backendConnectionId: string, value: T): LocatedAgentResource<T> {
  return { backendConnectionId: backendConnectionId || LOCAL_BACKEND_CONNECTION_ID, value };
}

export function identityOf<T extends { id: string }>(resource: LocatedAgentResource<T>): AgentResourceIdentity {
  return { backendConnectionId: resource.backendConnectionId, id: resource.value.id };
}

export function workspaceAgentIdentity(workspaceId: string, id: string): AgentResourceIdentity {
  return { backendConnectionId: backendConnectionIdForWorkspace(workspaceId), id };
}

export function nodeAgentIdentity(nodeId: string, id: string): AgentResourceIdentity {
  return { backendConnectionId: backendConnectionIdForNode(nodeId), id };
}

/** Resolve the connection captured by an API base returned by backendConnections.ts. */
export function backendConnectionIdFromApiBase(base: string): string {
  const match = /\/backend-connections\/([^/]+)\/proxy(?:\/|$)/.exec(base);
  if (!match) return LOCAL_BACKEND_CONNECTION_ID;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function parentAgentIndexKey(
  backendConnectionId: string,
  parentMessageId: string,
  parentToolCallId: string | null,
): string {
  return JSON.stringify([backendConnectionId, parentMessageId, parentToolCallId]);
}

export function parentTurnAgentIndexKey(backendConnectionId: string, parentTurnId: string): string {
  return JSON.stringify([backendConnectionId, parentTurnId]);
}

export function workspaceAgentIndexKey(backendConnectionId: string, workspaceId: string): string {
  return JSON.stringify([backendConnectionId, workspaceId]);
}
