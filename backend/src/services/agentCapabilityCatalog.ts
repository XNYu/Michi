import { createHash } from 'node:crypto';
import {
  assertSecretFreePublicPayload,
  type AgentCapabilityCatalogEntryV1,
  type EffectiveCapabilitySnapshotV1,
  type JsonValue,
} from 'michi-shared';
import { listEnabledBuiltinTools, type ParamField, type ParamSpec } from '../agents/builtinTools';
import { getRuntime } from '../agents/registry';
import { AGENT_RUN_TOOL_NAMES, type AgentRunToolName } from '../agents/runToolBridge';
import type { RuntimeRunAdapterRegistry } from '../agents/runs/runtimeRunAdapterRegistry';

export interface AgentCapabilityCatalogQuery {
  ownerUserId: string;
  workspaceId: string | null;
}

export interface AgentCapabilityCatalogSource {
  list(query: AgentCapabilityCatalogQuery): readonly AgentCapabilityCatalogEntryV1[];
}

export interface ResolveAgentCapabilitiesInput extends AgentCapabilityCatalogQuery {
  definitionScope: 'global' | 'workspace';
  toolRefs: readonly string[];
  skillRefs: readonly string[];
  mcpServerRefs: readonly string[];
}

function requireOwner(ownerUserId: string): void {
  if (!ownerUserId?.trim()) throw new Error('ownerUserId is required');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function paramSchema(spec: ParamSpec): JsonValue {
  if (typeof spec === 'string') return { type: spec };
  if ('array' in spec) return { type: 'array', items: paramSchema(spec.array) };
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(spec.object).map(([name, field]) => [name, fieldSchema(field)])),
    required: Object.entries(spec.object).filter(([, field]) => !field.optional).map(([name]) => name),
    additionalProperties: false,
  };
}

function fieldSchema(field: ParamField): JsonValue {
  return {
    ...paramSchema(field.type) as Record<string, unknown>,
    ...(field.description ? { description: field.description } : {}),
    ...(field.enum ? { enum: [...field.enum] } : {}),
  };
}

export class BuiltinAgentCapabilitySource implements AgentCapabilityCatalogSource {
  list(query: AgentCapabilityCatalogQuery): readonly AgentCapabilityCatalogEntryV1[] {
    requireOwner(query.ownerUserId);
    return listEnabledBuiltinTools().map((tool) => {
      const publicSchema = paramSchema(tool.parameters);
      const publicConfig = { description: tool.description };
      return {
        version: 1,
        id: tool.name,
        kind: 'tool' as const,
        ownerUserId: query.ownerUserId,
        workspaceId: null,
        revision: 'builtin-v1',
        readiness: 'ready' as const,
        publicSchema,
        publicConfig,
        schemaHash: sha256(publicSchema),
        contentHash: sha256(tool.description),
        configHash: sha256(publicConfig),
        credentialBindingIds: [],
      };
    });
  }
}

const AGENT_RUN_TOOL_DESCRIPTIONS: Record<AgentRunToolName, string> = {
  list_agents: 'List enabled Agents available to this Workspace.',
  spawn_agent: 'Start one durable Agent Run without creating a conversation branch.',
  check_agent: 'Read the latest durable status and compact handoff for one Agent Run.',
  wait_agent: 'Perform one bounded event-driven wait for a Run or Watch.',
  send_agent_input: 'Queue input or explicitly redirect the active Agent Run Attempt.',
  cancel_agent: 'Cancel the currently expected Agent Run Attempt.',
  watch_agent_runs: 'Create a durable Watch over independently running Agent Runs.',
  update_agent_watch: 'Add Runs or update the condition of an active Agent Watch.',
};

function agentRunToolSchema(name: AgentRunToolName): JsonValue {
  const string = { type: 'string' };
  const object = { type: 'object', additionalProperties: true };
  const definitions: Record<AgentRunToolName, Record<string, JsonValue>> = {
    list_agents: {},
    spawn_agent: { agentId: string, ephemeralDefinition: object, task: string, contextManifest: object,
      permissionRestriction: object, environment: object, expectedResult: object, completionMode: string, runTtlMs: { type: 'number' } },
    check_agent: { runId: string },
    wait_agent: { runId: string, watchId: string, timeoutMs: { type: 'number' } },
    send_agent_input: { runId: string, text: string, mode: string, expectedAttemptId: string },
    cancel_agent: { runId: string, reason: string, expectedAttemptId: string },
    watch_agent_runs: { runIds: { type: 'array', items: string }, condition: object, completionMode: string },
    update_agent_watch: { watchId: string, addRunIds: { type: 'array', items: string }, condition: object },
  };
  return { type: 'object', properties: definitions[name], additionalProperties: false };
}

/** Opt-in catalog source used only when the production session-bound Agent
 * tool factory is installed. Keeping it separate preserves the feature-off
 * Definition catalog byte-for-byte. */
export class AgentRunToolCapabilitySource implements AgentCapabilityCatalogSource {
  list(query: AgentCapabilityCatalogQuery): readonly AgentCapabilityCatalogEntryV1[] {
    requireOwner(query.ownerUserId);
    return AGENT_RUN_TOOL_NAMES.map((name) => {
      const publicSchema = agentRunToolSchema(name);
      const publicConfig = { description: AGENT_RUN_TOOL_DESCRIPTIONS[name] };
      return {
        version: 1,
        id: name,
        kind: 'tool' as const,
        ownerUserId: query.ownerUserId,
        workspaceId: null,
        revision: 'agent-run-tools-v1',
        readiness: 'ready' as const,
        publicSchema,
        publicConfig,
        schemaHash: sha256(publicSchema),
        contentHash: sha256(AGENT_RUN_TOOL_DESCRIPTIONS[name]),
        configHash: sha256(publicConfig),
        credentialBindingIds: [],
      };
    });
  }
}

export class AgentCapabilityCatalog {
  constructor(
    private readonly sources: readonly AgentCapabilityCatalogSource[] = [new BuiltinAgentCapabilitySource()],
    private readonly runtimeReady: (runtimeId: string) => boolean = (runtimeId) => !!getRuntime(runtimeId),
    private readonly adapterRegistry?: RuntimeRunAdapterRegistry,
  ) {}

  list(ownerUserId: string, workspaceId: string | null): AgentCapabilityCatalogEntryV1[] {
    requireOwner(ownerUserId);
    const entries = this.sources.flatMap((source) => [...source.list({ ownerUserId, workspaceId })]);
    const visible = entries.filter((entry) =>
      entry.ownerUserId === ownerUserId && (entry.workspaceId === null || entry.workspaceId === workspaceId));
    const byIdentity = new Map<string, AgentCapabilityCatalogEntryV1>();
    for (const entry of visible) {
      assertSecretFreePublicPayload(entry.publicSchema, `capability ${entry.id} schema`);
      assertSecretFreePublicPayload(entry.publicConfig, `capability ${entry.id} config`);
      byIdentity.set(`${entry.kind}:${entry.id}`, entry);
    }
    return [...byIdentity.values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  }

  assertRuntimeReady(runtimeId: string): void {
    if (!runtimeId?.trim() || !this.runtimeReady(runtimeId)) {
      throw new Error(`runtime ${runtimeId || '<empty>'} is not available`);
    }
    if (this.adapterRegistry && !this.adapterRegistry.has(runtimeId)) {
      const supported = this.adapterRegistry.supportedRuntimeIds();
      const list = supported.length > 0 ? supported.join(', ') : '(none)';
      throw new Error(
        `runtime ${runtimeId} does not have a Run adapter; `
        + `runtimes with Run adapters are ${list}`,
      );
    }
  }

  resolve(input: ResolveAgentCapabilitiesInput): EffectiveCapabilitySnapshotV1 {
    requireOwner(input.ownerUserId);
    const catalog = new Map(this.list(input.ownerUserId, input.workspaceId)
      .map((entry) => [`${entry.kind}:${entry.id}`, entry]));
    const requested = [
      ...input.toolRefs.map((id) => ({ kind: 'tool' as const, id })),
      ...input.skillRefs.map((id) => ({ kind: 'skill' as const, id })),
      ...input.mcpServerRefs.map((id) => ({ kind: 'mcp_server' as const, id })),
    ];
    if (new Set(requested.map((ref) => `${ref.kind}:${ref.id}`)).size !== requested.length) {
      throw new Error('capability references must be unique');
    }
    const entries = requested.map((ref) => {
      const entry = catalog.get(`${ref.kind}:${ref.id}`);
      if (!entry) throw new Error(`capability ${ref.kind}:${ref.id} was not found`);
      if (input.definitionScope === 'global' && entry.workspaceId !== null) {
        throw new Error(`global definitions cannot reference workspace capability ${ref.id}`);
      }
      if (entry.readiness !== 'ready') {
        throw new Error(`capability ${ref.kind}:${ref.id} is ${entry.readiness}`);
      }
      return {
        id: entry.id,
        kind: entry.kind,
        revision: entry.revision,
        schemaHash: entry.schemaHash,
        contentHash: entry.contentHash,
        configHash: entry.configHash,
        publicSchema: entry.publicSchema,
        publicConfig: entry.publicConfig,
        credentialBindingIds: [...entry.credentialBindingIds],
      };
    });
    return { version: 1, entries };
  }
}
