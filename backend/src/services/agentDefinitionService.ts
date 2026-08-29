import { randomUUID } from 'node:crypto';
import {
  AgentDefinitionStatus,
  MAX_RUN_TTL_MS,
  parseAgentDefinitionDtoV1,
  parseRunTtl,
  type AgentDefinitionDtoV1,
  type AgentEnableBlockerV1,
  type CreateAgentDefinitionRequestV1,
  type RuntimeProfileV1,
  type UpdateAgentDefinitionRequestV1,
} from 'michi-shared';
import { getRuntime } from '../agents/registry';
import { getProviderApiKey } from './secrets';
import { AgentCapabilityCatalog } from './agentCapabilityCatalog';
import { AgentDefinitionsRepository } from './agentDefinitionsRepository';
import type { RuntimeRunAdapterRegistry } from '../agents/runs/runtimeRunAdapterRegistry';

/**
 * Enable failed for structural reasons. Carries every blocker at once so the
 * editor can render an actionable "cannot enable yet" list instead of a
 * first-failure message. The message stays a joined summary for plain
 * consumers and existing error-shape assertions.
 */
export class AgentEnableBlockedError extends Error {
  constructor(readonly blockers: AgentEnableBlockerV1[]) {
    super(blockers.map((blocker) => blocker.message).join('; '));
    this.name = 'AgentEnableBlockedError';
  }
}

export interface RuntimeProfileReadiness {
  validate(profile: RuntimeProfileV1, ownerUserId: string): Promise<void> | void;
}

export interface AgentSpawnRetentionMetadata {
  defaultRunTtlMs: number | null;
  maxRunTtlMs: number;
  indefiniteByDefault: boolean;
}

export interface AgentDefinitionServiceDeps {
  repository?: AgentDefinitionsRepository;
  capabilityCatalog?: AgentCapabilityCatalog;
  runtimeReadiness?: RuntimeProfileReadiness;
  /** When supplied, enable checks validate that every runtime profile in the
   * primary/fallback chain has a registered Run adapter in addition to a
   * registered AgentRuntime. */
  adapterRegistry?: RuntimeRunAdapterRegistry;
  createOperationId?: () => string;
}

class RegisteredRuntimeReadiness implements RuntimeProfileReadiness {
  constructor(private readonly adapterRegistry?: RuntimeRunAdapterRegistry) {}

  validate(profile: RuntimeProfileV1, ownerUserId: string): void {
    const runtime = getRuntime(profile.runtimeId);
    if (!runtime) throw new Error(`runtime ${profile.runtimeId} is not available`);
    if (this.adapterRegistry && !this.adapterRegistry.has(profile.runtimeId)) {
      const supported = this.adapterRegistry.supportedRuntimeIds();
      const list = supported.length > 0 ? supported.join(', ') : '(none)';
      throw new Error(
        `runtime ${profile.runtimeId} does not have a Run adapter; `
        + `runtimes with Run adapters are ${list}`,
      );
    }
    if (runtime.capabilities.providerModels && !profile.providerId) {
      throw new Error(`runtime ${profile.runtimeId} requires a provider`);
    }
    if (runtime.capabilities.models && !profile.modelId) {
      throw new Error(`runtime ${profile.runtimeId} requires a model`);
    }
    if (runtime.capabilities.apiKeys) {
      if (!profile.providerId) throw new Error(`runtime ${profile.runtimeId} requires a provider credential`);
      const keyOwner = process.env.MICHI_CLOUD === '1' ? ownerUserId : undefined;
      if (!getProviderApiKey(profile.providerId, keyOwner)) {
        throw new Error(`provider ${profile.providerId} requires a configured credential`);
      }
    }
  }
}

function requireOwner(ownerUserId: string): void {
  if (!ownerUserId?.trim()) throw new Error('ownerUserId is required');
}

export class AgentDefinitionService {
  readonly repository: AgentDefinitionsRepository;
  readonly capabilityCatalog: AgentCapabilityCatalog;
  private readonly runtimeReadiness: RuntimeProfileReadiness;
  private readonly createOperationId: () => string;

  constructor(deps: AgentDefinitionServiceDeps = {}) {
    this.capabilityCatalog = deps.capabilityCatalog ?? new AgentCapabilityCatalog();
    this.repository = deps.repository ?? new AgentDefinitionsRepository({ capabilityCatalog: this.capabilityCatalog });
    this.runtimeReadiness = deps.runtimeReadiness ?? new RegisteredRuntimeReadiness(deps.adapterRegistry);
    this.createOperationId = deps.createOperationId ?? (() => randomUUID());
  }

  operationId(value?: string): string {
    const operationId = value?.trim() || this.createOperationId();
    if (operationId.length > 256) throw new Error('idempotency key must be at most 256 characters');
    return operationId;
  }

  private validateCreate(ownerUserId: string, request: CreateAgentDefinitionRequestV1): CreateAgentDefinitionRequestV1 {
    requireOwner(ownerUserId);
    const now = Date.now();
    const parsed = parseAgentDefinitionDtoV1({
      ...request, id: '__validation__', ownerUserId, status: AgentDefinitionStatus.Draft,
      revision: 1, createdAt: now, updatedAt: now,
    });
    return {
      version: 1, scope: parsed.scope, workspaceId: parsed.workspaceId,
      name: parsed.name, description: parsed.description, instructions: parsed.instructions,
      runtimeProfile: parsed.runtimeProfile, fallbackChain: parsed.fallbackChain,
      toolRefs: parsed.toolRefs, skillRefs: parsed.skillRefs, mcpServerRefs: parsed.mcpServerRefs,
      permissionPolicy: parsed.permissionPolicy, contextPolicy: parsed.contextPolicy,
      defaultRunTtlMs: parsed.defaultRunTtlMs,
    };
  }

  private async validateEnable(ownerUserId: string, definition: AgentDefinitionDtoV1): Promise<void> {
    // Instructions are intentionally NOT validated: an Agent Definition is
    // [permissions, capabilities, when-to-use]; the parent supplies the task
    // (and any method hints) each run, so empty instructions are valid.
    const blockers: AgentEnableBlockerV1[] = [];
    const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
    if (!definition.runtimeProfile.runtimeId.trim()) {
      blockers.push({ code: 'runtime', ref: null, message: 'runtime is required before enabling' });
    } else {
      try { await this.runtimeReadiness.validate(definition.runtimeProfile, ownerUserId); }
      catch (err) { blockers.push({ code: 'runtime', ref: definition.runtimeProfile.runtimeId, message: message(err) }); }
    }
    for (const fallback of definition.fallbackChain) {
      if (!fallback.runtimeId.trim()) {
        blockers.push({ code: 'fallback', ref: null, message: 'fallback runtime is required before enabling' });
        continue;
      }
      try { await this.runtimeReadiness.validate(fallback, ownerUserId); }
      catch (err) { blockers.push({ code: 'fallback', ref: fallback.runtimeId, message: message(err) }); }
    }
    const catalog = new Map(this.capabilityCatalog.list(ownerUserId, definition.workspaceId)
      .map((entry) => [`${entry.kind}:${entry.id}`, entry]));
    const requested = [
      ...definition.toolRefs.map((id) => ({ kind: 'tool' as const, id })),
      ...definition.skillRefs.map((id) => ({ kind: 'skill' as const, id })),
      ...definition.mcpServerRefs.map((id) => ({ kind: 'mcp_server' as const, id })),
    ];
    for (const ref of requested) {
      const key = `${ref.kind}:${ref.id}`;
      const entry = catalog.get(key);
      if (!entry) { blockers.push({ code: 'capability', ref: key, message: `capability ${key} was not found` }); continue; }
      if (definition.scope === 'global' && entry.workspaceId !== null) {
        blockers.push({ code: 'capability', ref: key, message: `global definitions cannot reference workspace capability ${ref.id}` });
        continue;
      }
      if (entry.readiness !== 'ready') {
        blockers.push({ code: 'capability', ref: key, message: `capability ${key} is ${entry.readiness}` });
      }
    }
    if (blockers.length > 0) throw new AgentEnableBlockedError(blockers);
    // Defensive: the snapshot-side resolve enforces the same invariants plus
    // uniqueness; with zero blockers it must succeed.
    this.capabilityCatalog.resolve({
      ownerUserId, workspaceId: definition.workspaceId, definitionScope: definition.scope,
      toolRefs: definition.toolRefs, skillRefs: definition.skillRefs,
      mcpServerRefs: definition.mcpServerRefs,
    });
  }

  async create(ownerUserId: string, request: CreateAgentDefinitionRequestV1, operationId?: string): Promise<AgentDefinitionDtoV1> {
    const valid = this.validateCreate(ownerUserId, request);
    return this.repository.create(ownerUserId, valid, this.operationId(operationId));
  }

  get(ownerUserId: string, id: string): AgentDefinitionDtoV1 | null {
    requireOwner(ownerUserId);
    return this.repository.get(ownerUserId, id);
  }

  list(ownerUserId: string, workspaceId: string | null): AgentDefinitionDtoV1[] {
    requireOwner(ownerUserId);
    return this.repository.list(ownerUserId, workspaceId, false);
  }

  discoverEnabled(ownerUserId: string, workspaceId: string): AgentDefinitionDtoV1[] {
    requireOwner(ownerUserId);
    return this.repository.list(ownerUserId, workspaceId, true);
  }

  async getSpawnable(ownerUserId: string, id: string, workspaceId: string): Promise<AgentDefinitionDtoV1 | null> {
    requireOwner(ownerUserId);
    const definition = this.repository.list(ownerUserId, workspaceId, true)
      .find((candidate) => candidate.id === id) ?? null;
    if (!definition) return null;
    await this.validateEnable(ownerUserId, definition);
    return definition;
  }

  async update(ownerUserId: string, id: string, request: UpdateAgentDefinitionRequestV1, operationId?: string): Promise<AgentDefinitionDtoV1 | null> {
    requireOwner(ownerUserId);
    const current = this.repository.get(ownerUserId, id);
    if (!current) return null;
    const candidate = parseAgentDefinitionDtoV1({
      ...current, ...request, id, ownerUserId, version: 1, status: current.status,
      revision: current.revision + 1, createdAt: current.createdAt, updatedAt: Math.max(Date.now(), current.updatedAt),
    });
    if (current.status === AgentDefinitionStatus.Enabled) await this.validateEnable(ownerUserId, candidate);
    return this.repository.update(ownerUserId, id, request, this.operationId(operationId));
  }

  async enable(ownerUserId: string, id: string, operationId?: string): Promise<AgentDefinitionDtoV1 | null> {
    requireOwner(ownerUserId);
    const current = this.repository.get(ownerUserId, id);
    if (!current) return null;
    await this.validateEnable(ownerUserId, current);
    return this.repository.enable(ownerUserId, id, current.revision, this.operationId(operationId));
  }

  disable(ownerUserId: string, id: string, operationId?: string): AgentDefinitionDtoV1 | null {
    requireOwner(ownerUserId);
    const current = this.repository.get(ownerUserId, id);
    if (!current) return null;
    return this.repository.disable(ownerUserId, id, current.revision, this.operationId(operationId));
  }

  duplicate(ownerUserId: string, id: string, workspaceId?: string | null, operationId?: string): AgentDefinitionDtoV1 | null {
    requireOwner(ownerUserId);
    const source = this.repository.get(ownerUserId, id);
    if (!source) return null;
    const targetWorkspaceId = workspaceId === undefined ? source.workspaceId : workspaceId;
    return this.repository.duplicate(ownerUserId, id, targetWorkspaceId, this.operationId(operationId));
  }

  delete(ownerUserId: string, id: string, operationId?: string): boolean {
    requireOwner(ownerUserId);
    return this.repository.delete(ownerUserId, id, this.operationId(operationId));
  }

  retentionMetadata(definition: Pick<AgentDefinitionDtoV1, 'defaultRunTtlMs'>): AgentSpawnRetentionMetadata {
    const defaultRunTtlMs = parseRunTtl(definition.defaultRunTtlMs);
    return { defaultRunTtlMs, maxRunTtlMs: MAX_RUN_TTL_MS, indefiniteByDefault: defaultRunTtlMs === null };
  }
}
