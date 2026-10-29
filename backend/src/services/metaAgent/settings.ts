import { listToolApprovals } from './toolApprovals';
/**
 * The one Meta agent settings record (shared/src/metaAgent.ts). Background
 * maintenance resolves it at the start of every run; nothing copies its
 * values. The assistant conversation runs on the global settings instead
 * (assistant/store.ts). Stored in `meta`, one key per owner, like
 * the chat permission settings.
 */

import {
  META_AGENT_DEFAULT_FIRST_RUN_DAYS,
  META_AGENT_FIRST_RUN_DAYS,
  isAssistantWorkspaceSettings,
  isReasoningLevel,
  type MetaAgentFirstRunDays,
  type MetaAgentInfo,
  type MetaAgentResolvedRuntime,
  type MetaAgentSettings,
  type MetaAgentSettingsPatch,
  type MetaAgentToolset,
  type MetaAgentUsageToday,
  type RuntimeReasoning,
} from 'michi-shared';
import { getRuntime, listRuntimes } from '../../agents/registry';
import { maintenanceRuntimeAvailability } from '../../agents/maintenancePolicy';
import { LOCAL_AGENT_OWNER_ID } from '../agentOwner';
import { getAgentConfig, resolveModel, resolveProvider, resolveReasoning } from '../agentConfig';
import { getDb } from '../db';
import { listWorkspaces } from '../dbRepository';
import { log } from '../logger';
import { getMetaAgentGuardStatus } from './guardStatus';
import { metaAgentUsageToday } from './todayUsage';

export class MetaAgentSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaAgentSettingsError';
  }
}

const FOLLOW_GLOBAL_RUNTIME = Object.freeze({ runtimeId: null, providerId: null, modelId: null, reasoning: null });
const DEFAULT_BEHAVIOUR = Object.freeze({ writeWorkspaceHomes: null, maintainSpacesHome: null, firstRunDays: null });
const FOLLOW_GLOBAL: MetaAgentSettings = Object.freeze({ ...FOLLOW_GLOBAL_RUNTIME, ...DEFAULT_BEHAVIOUR });

/** Ids reach CLI argv, so they never start with `-`. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]{0,199}$/;

const isCloud = () => process.env.MICHI_CLOUD === '1';

function settingsKey(ownerUserId?: string | null): string {
  if (isCloud()) {
    if (!ownerUserId) throw new Error('Meta agent settings require an authenticated owner');
    return `meta_agent_settings:user:${ownerUserId}`;
  }
  return 'meta_agent_settings:desktop';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idOrNull(value: unknown): string | null {
  return typeof value === 'string' && ID.test(value.trim()) ? value.trim() : null;
}

const isFirstRunDays = (value: unknown): value is MetaAgentFirstRunDays => (META_AGENT_FIRST_RUN_DAYS as readonly unknown[]).includes(value);

/** A record without a runtime follows global as a whole, so its other runtime fields are dropped; reading and writing fields stand alone. */
function normalize(value: unknown): MetaAgentSettings {
  const stored = isObject(value) ? value : {};
  const behaviour = {
    writeWorkspaceHomes: typeof stored.writeWorkspaceHomes === 'boolean' ? stored.writeWorkspaceHomes : null,
    maintainSpacesHome: typeof stored.maintainSpacesHome === 'boolean' ? stored.maintainSpacesHome : null,
    firstRunDays: isFirstRunDays(stored.firstRunDays) ? stored.firstRunDays : null,
  };
  const runtimeId = idOrNull(stored.runtimeId);
  if (!runtimeId) return { ...FOLLOW_GLOBAL_RUNTIME, ...behaviour };
  return {
    runtimeId,
    providerId: idOrNull(stored.providerId),
    modelId: idOrNull(stored.modelId),
    reasoning: isReasoningLevel(stored.reasoning) ? stored.reasoning : null,
    ...behaviour,
  };
}

function parseStored(raw: string): MetaAgentSettings {
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return { ...FOLLOW_GLOBAL };
  }
}

/** The runtimes the assistant used to accept, in the order its default was picked from. */
const LEGACY_ASSISTANT_RUNTIMES = ['claude', 'codex', 'pi'];

/** What an assistant whose settings were never changed stored: the global runtime when it could host it, else the first one it accepted. */
function legacyAssistantDefault(globalRuntime: string): string | null {
  const registered = LEGACY_ASSISTANT_RUNTIMES.filter((id) => !!getRuntime(id));
  return registered.includes(globalRuntime) ? globalRuntime : registered[0] ?? null;
}

/**
 * The assistant's settings from before this record existed. A choice equal
 * to what the global settings give, or to the default the assistant stored
 * when nobody chose, becomes follow-global; anything else stays as an
 * explicit choice.
 */
function legacyAssistantSettings(): MetaAgentSettings {
  if (isCloud()) return { ...FOLLOW_GLOBAL };
  const workspace = listWorkspaces()
    .filter((ws) => ws.deleted_at == null && isAssistantWorkspaceSettings(ws.settings))
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!workspace) return { ...FOLLOW_GLOBAL };
  let stored: unknown;
  try { stored = (JSON.parse(workspace.settings ?? '{}') as Record<string, unknown>).assistant; } catch { return { ...FOLLOW_GLOBAL }; }
  if (!isObject(stored)) return { ...FOLLOW_GLOBAL };
  const runtimeId = idOrNull(stored.runtimeId);
  if (!runtimeId || !getRuntime(runtimeId)) return { ...FOLLOW_GLOBAL };
  const modelId = idOrNull(stored.modelId);
  const reasoning = isReasoningLevel(stored.reasoning) ? stored.reasoning : null;
  const global = getAgentConfig();
  const sameAsGlobal = runtimeId === global.runtime
    && (modelId === null || modelId === global.modelByRuntime[runtimeId])
    && (reasoning === null || reasoning === global.reasoningByRuntime[runtimeId]);
  const untouched = modelId === null && reasoning === null && runtimeId === legacyAssistantDefault(global.runtime);
  return sameAsGlobal || untouched ? { ...FOLLOW_GLOBAL } : { runtimeId, providerId: null, modelId, reasoning, ...DEFAULT_BEHAVIOUR };
}

function readRow(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** The stored record. The first read creates it, folding in the assistant's old settings once. */
export function getMetaAgentSettings(ownerUserId?: string | null): MetaAgentSettings {
  const key = settingsKey(ownerUserId);
  const raw = readRow(key);
  if (raw !== null) return parseStored(raw);
  getDb().prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(key, JSON.stringify(legacyAssistantSettings()));
  return parseStored(readRow(key) ?? '{}');
}

function patchId(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !ID.test(value.trim())) {
    throw new MetaAgentSettingsError(`${field} must be an id (letters, digits and . _ : / @ [ ] + -, starting with a letter or digit) or null`);
  }
  return value.trim();
}

function patchFlag(value: unknown, field: string): boolean | null {
  if (value !== null && typeof value !== 'boolean') throw new MetaAgentSettingsError(`${field} must be true, false or null`);
  return value;
}

/**
 * Validates and stores a patch. Whether a runtime can host the Meta agent is
 * checked when a run starts, not here: any registered runtime is accepted.
 */
export function updateMetaAgentSettings(patch: MetaAgentSettingsPatch, ownerUserId?: string | null): MetaAgentSettings {
  if (!isObject(patch)) throw new MetaAgentSettingsError('settings must be an object');
  let runtimeId: string | null | undefined;
  if (patch.runtimeId !== undefined) {
    if (patch.runtimeId !== null && (typeof patch.runtimeId !== 'string' || !getRuntime(patch.runtimeId))) {
      const registered = listRuntimes().map((runtime) => runtime.id);
      throw new MetaAgentSettingsError(`runtimeId must be null or one of: ${registered.join(', ') || '(none registered)'}`);
    }
    runtimeId = patch.runtimeId;
  }
  const providerId = patch.providerId === undefined ? undefined : patchId(patch.providerId, 'providerId');
  const modelId = patch.modelId === undefined ? undefined : patchId(patch.modelId, 'modelId');
  if (patch.reasoning !== undefined && patch.reasoning !== null && !isReasoningLevel(patch.reasoning)) {
    throw new MetaAgentSettingsError('reasoning must be minimal, low, medium, high, xhigh, max or null');
  }
  const reasoning: RuntimeReasoning | null | undefined = patch.reasoning;
  const writeWorkspaceHomes = patch.writeWorkspaceHomes === undefined ? undefined : patchFlag(patch.writeWorkspaceHomes, 'writeWorkspaceHomes');
  const maintainSpacesHome = patch.maintainSpacesHome === undefined ? undefined : patchFlag(patch.maintainSpacesHome, 'maintainSpacesHome');
  if (patch.firstRunDays !== undefined && patch.firstRunDays !== null && !isFirstRunDays(patch.firstRunDays)) {
    throw new MetaAgentSettingsError(`firstRunDays must be ${META_AGENT_FIRST_RUN_DAYS.join(', ')} or null`);
  }

  const current = getMetaAgentSettings(ownerUserId);
  const behaviour = {
    writeWorkspaceHomes: writeWorkspaceHomes !== undefined ? writeWorkspaceHomes : current.writeWorkspaceHomes ?? null,
    maintainSpacesHome: maintainSpacesHome !== undefined ? maintainSpacesHome : current.maintainSpacesHome ?? null,
    firstRunDays: patch.firstRunDays !== undefined ? patch.firstRunDays : current.firstRunDays ?? null,
  };
  const nextRuntime = runtimeId === undefined ? current.runtimeId : runtimeId;
  let next: MetaAgentSettings;
  if (nextRuntime === null) {
    next = { ...FOLLOW_GLOBAL_RUNTIME, ...behaviour };
  } else {
    // A provider and model belong to one runtime; a switch that names neither follows global for the new one.
    const switched = nextRuntime !== current.runtimeId;
    next = {
      runtimeId: nextRuntime,
      providerId: providerId !== undefined ? providerId : switched ? null : current.providerId,
      modelId: modelId !== undefined ? modelId : switched ? null : current.modelId,
      reasoning: reasoning !== undefined ? reasoning : current.reasoning,
      ...behaviour,
    };
  }
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(settingsKey(ownerUserId), JSON.stringify(next));
  return next;
}

/** What the reading and writing settings mean now, defaults filled in. Background runs read it when they start. */
export interface MetaAgentBehaviour {
  writeWorkspaceHomes: boolean;
  maintainSpacesHome: boolean;
  firstRunDays: MetaAgentFirstRunDays;
}

export function resolveMetaAgentBehaviour(ownerUserId?: string | null): MetaAgentBehaviour {
  const settings = getMetaAgentSettings(ownerUserId);
  return {
    writeWorkspaceHomes: settings.writeWorkspaceHomes !== false,
    maintainSpacesHome: settings.maintainSpacesHome !== false,
    firstRunDays: settings.firstRunDays ?? META_AGENT_DEFAULT_FIRST_RUN_DAYS,
  };
}

/**
 * What a run starting now uses: each field of the record, else the global
 * settings read at this moment for the resolved runtime. Call it once at the
 * start of a run and use that answer for the whole run.
 */
export function resolveMetaAgentRuntime(ownerUserId?: string | null): MetaAgentResolvedRuntime {
  const settings = getMetaAgentSettings(ownerUserId);
  const userId = isCloud() ? ownerUserId ?? undefined : undefined;
  const runtimeId = settings.runtimeId ?? getAgentConfig(userId).runtime;
  const usesProviders = getRuntime(runtimeId)?.capabilities.providerModels === true;
  const globalProvider = usesProviders ? resolveProvider(runtimeId, userId) || null : null;
  const providerId = usesProviders ? settings.providerId ?? globalProvider : null;
  // The global model belongs to the global provider; another provider starts on its own default.
  const modelId = settings.modelId
    ?? (providerId !== globalProvider ? null : resolveModel(runtimeId, userId) || null);
  const reasoning = settings.reasoning ?? (resolveReasoning(runtimeId, userId) as RuntimeReasoning | undefined) ?? null;
  return { runtimeId, providerId, modelId, reasoning, followsGlobal: settings.runtimeId === null };
}

/** GET /api/meta-agent. */
export function metaAgentInfo(ownerUserId?: string | null, now = Date.now(), usage?: MetaAgentUsageToday | null): MetaAgentInfo {
  const resolved = resolveMetaAgentRuntime(ownerUserId);
  const availability = maintenanceRuntimeAvailability(resolved.runtimeId);
  const guard = (toolset: MetaAgentToolset) => getMetaAgentGuardStatus(toolset, () => resolved, ownerUserId);
  return {
    settings: getMetaAgentSettings(ownerUserId),
    resolved,
    availability: { available: availability.available, reason: availability.available ? null : availability.reason ?? null },
    guard: { maintenance: guard('maintenance'), chat: null },
    usageToday: usage === undefined ? usageToday(ownerUserId, now) : usage,
    toolApprovals: listToolApprovals(ownerUserId),
  };
}

/** Counting is best-effort: the settings still load when it fails. */
function usageToday(ownerUserId: string | null | undefined, now: number): MetaAgentUsageToday | null {
  try {
    return metaAgentUsageToday(ownerUserId ?? LOCAL_AGENT_OWNER_ID, now);
  } catch (err) {
    log.warn('scheduler', 'could not count the Meta agent usage', { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
