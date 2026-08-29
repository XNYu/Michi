import type {
  AgentCapabilityCatalogEntryV1,
  AgentDefinitionDtoV1,
  AgentEnableBlockerV1,
  CreateAgentDefinitionRequestV1,
  UpdateAgentDefinitionRequestV1,
} from 'michi-shared';
import { parseAgentDefinitionDtoV1 } from 'michi-shared';
import {
  activeBackendApiBase,
  backendApiBase,
  workspaceBackendApiBase,
} from '../../config/backendConnections';
import {
  type AgentResourceIdentity,
  type LocatedAgentResource,
  backendConnectionIdFromApiBase,
  locatedAgentResource,
} from '../../state/agentIdentity';

/** Enable was refused for structural reasons; `blockers` lists every one. */
export class AgentEnableBlockedError extends Error {
  constructor(message: string, readonly blockers: AgentEnableBlockerV1[]) {
    super(message);
    this.name = 'AgentEnableBlockedError';
  }
}

function parseBlockers(value: unknown): AgentEnableBlockerV1[] | null {
  if (!value || typeof value !== 'object' || !('blockers' in value) || !Array.isArray(value.blockers)) return null;
  const blockers: AgentEnableBlockerV1[] = [];
  for (const entry of value.blockers) {
    if (!entry || typeof entry !== 'object') return null;
    const { code, ref, message } = entry as Record<string, unknown>;
    if ((code !== 'runtime' && code !== 'fallback' && code !== 'capability')
      || (ref !== null && typeof ref !== 'string') || typeof message !== 'string') return null;
    blockers.push({ code, ref: ref as string | null, message });
  }
  return blockers;
}

async function jsonResponse(response: Response, operation: string): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `${operation} failed: ${response.status}`;
    const blockers = parseBlockers(body);
    if (blockers) throw new AgentEnableBlockedError(message, blockers);
    throw new Error(message);
  }
  return body;
}

function definitionPayload(value: unknown): unknown {
  if (value && typeof value === 'object' && 'definition' in value) return value.definition;
  return value;
}

function definitionListPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && 'definitions' in value && Array.isArray(value.definitions)) return value.definitions;
  throw new Error('listAgentDefinitions returned a malformed payload');
}

function initialDefinitionBase(workspaceId?: string | null): { base: string; backendConnectionId: string } {
  const base = workspaceId ? workspaceBackendApiBase(workspaceId) : activeBackendApiBase();
  return { base, backendConnectionId: backendConnectionIdFromApiBase(base) };
}

export async function listAgentDefinitions(
  workspaceId?: string | null,
  signal?: AbortSignal,
): Promise<Array<LocatedAgentResource<AgentDefinitionDtoV1>>> {
  const target = initialDefinitionBase(workspaceId);
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const payload = await jsonResponse(await fetch(`${target.base}/agents${query}`, { signal }), 'listAgentDefinitions');
  return definitionListPayload(payload).map((definition, index) => locatedAgentResource(
    target.backendConnectionId,
    parseAgentDefinitionDtoV1(definition, `definitions[${index}]`),
  ));
}

export async function getAgentDefinition(
  identity: AgentResourceIdentity,
  signal?: AbortSignal,
): Promise<LocatedAgentResource<AgentDefinitionDtoV1>> {
  const payload = await jsonResponse(await fetch(
    `${backendApiBase(identity.backendConnectionId)}/agents/${encodeURIComponent(identity.id)}`,
    { signal },
  ), 'getAgentDefinition');
  return locatedAgentResource(identity.backendConnectionId, parseAgentDefinitionDtoV1(definitionPayload(payload)));
}

export async function createAgentDefinition(
  request: CreateAgentDefinitionRequestV1,
  signal?: AbortSignal,
  globalBackendConnectionId?: string,
): Promise<LocatedAgentResource<AgentDefinitionDtoV1>> {
  const target = request.scope === 'global' && globalBackendConnectionId
    ? { base: backendApiBase(globalBackendConnectionId), backendConnectionId: globalBackendConnectionId }
    : initialDefinitionBase(request.scope === 'workspace' ? request.workspaceId : null);
  const payload = await jsonResponse(await fetch(`${target.base}/agents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal,
  }), 'createAgentDefinition');
  return locatedAgentResource(target.backendConnectionId, parseAgentDefinitionDtoV1(definitionPayload(payload)));
}

export async function updateAgentDefinition(
  identity: AgentResourceIdentity,
  request: UpdateAgentDefinitionRequestV1,
  signal?: AbortSignal,
): Promise<LocatedAgentResource<AgentDefinitionDtoV1>> {
  const payload = await jsonResponse(await fetch(`${backendApiBase(identity.backendConnectionId)}/agents/${encodeURIComponent(identity.id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal,
  }), 'updateAgentDefinition');
  return locatedAgentResource(identity.backendConnectionId, parseAgentDefinitionDtoV1(definitionPayload(payload)));
}

async function definitionAction(identity: AgentResourceIdentity, action: 'enable' | 'disable' | 'duplicate', signal?: AbortSignal): Promise<LocatedAgentResource<AgentDefinitionDtoV1>> {
  const payload = await jsonResponse(await fetch(`${backendApiBase(identity.backendConnectionId)}/agents/${encodeURIComponent(identity.id)}/${action}`, { method: 'POST', signal }), `${action}AgentDefinition`);
  return locatedAgentResource(identity.backendConnectionId, parseAgentDefinitionDtoV1(definitionPayload(payload)));
}

export const enableAgentDefinition = (identity: AgentResourceIdentity, signal?: AbortSignal) => definitionAction(identity, 'enable', signal);
export const disableAgentDefinition = (identity: AgentResourceIdentity, signal?: AbortSignal) => definitionAction(identity, 'disable', signal);
export const duplicateAgentDefinition = (identity: AgentResourceIdentity, signal?: AbortSignal) => definitionAction(identity, 'duplicate', signal);

export async function deleteAgentDefinition(identity: AgentResourceIdentity, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${backendApiBase(identity.backendConnectionId)}/agents/${encodeURIComponent(identity.id)}`, { method: 'DELETE', signal });
  if (!response.ok) throw new Error(`deleteAgentDefinition failed: ${response.status}`);
}

/**
 * Browse-time capability catalog for the editor: every tool / skill / MCP
 * server visible in the Workspace scope, with readiness so unresolved refs
 * can be flagged before enable is attempted.
 */
export async function listAgentCapabilities(
  workspaceId?: string | null,
  signal?: AbortSignal,
): Promise<AgentCapabilityCatalogEntryV1[]> {
  const target = initialDefinitionBase(workspaceId);
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const payload = await jsonResponse(
    await fetch(`${target.base}/agent-capabilities${query}`, { signal }),
    'listAgentCapabilities',
  );
  if (!payload || typeof payload !== 'object' || !('capabilities' in payload) || !Array.isArray(payload.capabilities)) {
    throw new Error('listAgentCapabilities returned a malformed payload');
  }
  return payload.capabilities as AgentCapabilityCatalogEntryV1[];
}
