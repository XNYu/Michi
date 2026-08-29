import { parseAgentDefinitionDtoV1, type AgentDefinitionDtoV1 } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import type { AgentResourceIdentity, LocatedAgentResource } from '../../state/agentIdentity';
import { locatedAgentResource } from '../../state/agentIdentity';

export interface ContinueAgentRunActionRequest {
  version: 1;
  workspaceId: string;
  includeTask: boolean;
  includeResult: boolean;
  includeTranscript: boolean;
  fallback: 'error' | 'new_thread';
}

export interface ContinueAgentRunActionResult {
  version: 1;
  runId: string;
  workspaceId: string;
  nodeId: string;
  treeId: string;
  parentNodeId: string | null;
  mode: 'branch' | 'new_thread';
  imported: { task: boolean; result: boolean; transcript: boolean };
}

export class AgentRunActionApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AgentRunActionApiError'; }
}

export function createAgentRunActionOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `agent-run-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function responseJson(response: Response, operation: string): Promise<Record<string, any>> {
  const body = await response.json().catch(() => null) as Record<string, any> | null;
  if (!response.ok) throw new AgentRunActionApiError(typeof body?.error === 'string' ? body.error : 'request_failed',
    typeof body?.message === 'string' ? body.message : `${operation} failed: ${response.status}`);
  if (!body || typeof body !== 'object') throw new Error(`${operation} returned a malformed response`);
  return body;
}

export async function continueAgentRunAsBranch(identity: AgentResourceIdentity,
  request: ContinueAgentRunActionRequest, operationId: string, signal?: AbortSignal): Promise<ContinueAgentRunActionResult> {
  const payload = await responseJson(await fetch(`${backendApiBase(identity.backendConnectionId)}/agent-runs/${encodeURIComponent(identity.id)}/continue-as-branch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-idempotency-key': operationId },
    body: JSON.stringify(request), signal,
  }), 'continueAgentRunAsBranch');
  return payload as unknown as ContinueAgentRunActionResult;
}

export async function saveAgentRunAsCustomAgent(identity: AgentResourceIdentity,
  request: { version: 1; workspaceId: string; name?: string }, operationId: string,
  signal?: AbortSignal): Promise<LocatedAgentResource<AgentDefinitionDtoV1>> {
  const payload = await responseJson(await fetch(`${backendApiBase(identity.backendConnectionId)}/agent-runs/${encodeURIComponent(identity.id)}/save-as-agent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-idempotency-key': operationId },
    body: JSON.stringify(request), signal,
  }), 'saveAgentRunAsCustomAgent');
  return locatedAgentResource(identity.backendConnectionId, parseAgentDefinitionDtoV1(payload.definition));
}
