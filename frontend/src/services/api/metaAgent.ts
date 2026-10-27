import type {
  MetaAgentGuardStatus, MetaAgentInfo as SharedMetaAgentInfo, MetaAgentSettingsPatch, MetaAgentToolset, MetaAgentUsageToday,
} from 'michi-shared';
import { META_AGENT_FIRST_RUN_DAYS } from 'michi-shared';
import { API_BASE_URL } from '../../config/env';

// The Meta agent's one settings record, served by the local backend's
// `/api/meta-agent`. A backend without it answers 404; callers show it as
// unavailable rather than as a failure.

export type { MetaAgentSettingsPatch };

export type MetaAgentInfo = SharedMetaAgentInfo;
export type MetaAgentAvailability = SharedMetaAgentInfo['availability'];

/** Every runtime field null: the Meta agent follows the global runtime settings. Reading and writing settings are kept. */
export const FOLLOW_GLOBAL_PATCH: Required<Pick<MetaAgentSettingsPatch, 'runtimeId' | 'providerId' | 'modelId' | 'reasoning'>> = {
  runtimeId: null, providerId: null, modelId: null, reasoning: null,
};

export class MetaAgentApiError extends Error {
  readonly status: number;
  /** True when this backend has no Meta agent routes: a 404, or an answer of the wrong shape. */
  readonly unavailable: boolean;
  constructor(status: number, message: string, unavailable = status === 404) {
    super(message);
    this.name = 'MetaAgentApiError';
    this.status = status;
    this.unavailable = unavailable;
  }
}

export function isMetaAgentUnavailable(err: unknown): boolean {
  return err instanceof MetaAgentApiError && err.unavailable;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const nullableString = (value: unknown) => value === null || typeof value === 'string';

function isAvailability(value: unknown): value is MetaAgentAvailability | undefined {
  return value === undefined || (isObject(value) && typeof value.available === 'boolean' && nullableString(value.reason ?? null));
}

function isGuardStatus(value: unknown): value is MetaAgentGuardStatus | null {
  if (value === null) return true;
  return isObject(value)
    && (value.state === 'ok' || value.state === 'failed')
    && typeof value.runtimeId === 'string'
    && Array.isArray(value.unexpectedTools) && value.unexpectedTools.every((tool) => typeof tool === 'string')
    && typeof value.checkedAt === 'number';
}

const nullableFlag = (value: unknown) => value === undefined || value === null || typeof value === 'boolean';
const nullableDays = (value: unknown) => value === undefined || value === null || (META_AGENT_FIRST_RUN_DAYS as readonly unknown[]).includes(value);
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function isUsage(value: unknown): value is MetaAgentUsageToday | null | undefined {
  if (value === undefined || value === null) return true;
  return isObject(value) && count(value.checks) && count(value.modelCalls) && (value.tokens === null || count(value.tokens));
}

export function isMetaAgentInfo(value: unknown): value is SharedMetaAgentInfo & { availability?: MetaAgentAvailability } {
  if (!isObject(value) || !isObject(value.settings) || !isObject(value.resolved) || !isObject(value.guard)) return false;
  const { settings, resolved, guard } = value;
  return nullableString(settings.runtimeId) && nullableString(settings.providerId)
    && nullableString(settings.modelId) && nullableString(settings.reasoning)
    && nullableFlag(settings.writeWorkspaceHomes) && nullableFlag(settings.maintainSpacesHome) && nullableDays(settings.firstRunDays)
    && typeof resolved.runtimeId === 'string' && resolved.runtimeId !== ''
    && typeof resolved.followsGlobal === 'boolean'
    && isAvailability(value.availability)
    && isGuardStatus(guard.maintenance ?? null) && isGuardStatus(guard.chat ?? null)
    && isUsage(value.usageToday);
}

function errorMessage(body: unknown, status: number): string {
  if (isObject(body)) {
    if (typeof body.error === 'string') return body.error;
    if (isObject(body.error) && typeof body.error.message === 'string') return body.error.message;
  }
  return `Meta agent request failed (${status})`;
}

async function metaAgentJson(path: string, init: { method?: 'PUT' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<MetaAgentInfo> {
  const res = await fetch(`${API_BASE_URL}/meta-agent${path}`, {
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.method ? {
      method: init.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(init.body ?? {}),
    } : {}),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new MetaAgentApiError(res.status, errorMessage(body, res.status));
  if (!isMetaAgentInfo(body)) throw new MetaAgentApiError(res.status, 'Unexpected Meta agent response', true);
  const { settings } = body;
  return {
    ...body,
    settings: {
      ...settings,
      writeWorkspaceHomes: settings.writeWorkspaceHomes ?? null,
      maintainSpacesHome: settings.maintainSpacesHome ?? null,
      firstRunDays: settings.firstRunDays ?? null,
    },
    // An older backend answers without availability; that reads as available.
    availability: body.availability ? { available: body.availability.available, reason: body.availability.reason ?? null } : { available: true, reason: null },
    guard: { maintenance: body.guard.maintenance ?? null, chat: body.guard.chat ?? null },
    usageToday: body.usageToday ?? null,
  };
}

export function fetchMetaAgent(signal?: AbortSignal): Promise<MetaAgentInfo> {
  return metaAgentJson('', { signal });
}

/** Omitted fields keep their value; null follows the global settings (or the default) from the next run. */
export function updateMetaAgentSettings(patch: MetaAgentSettingsPatch): Promise<MetaAgentInfo> {
  return metaAgentJson('/settings', { method: 'PUT', body: patch });
}

/**
 * Clears a failed restriction check so the Meta agent runs again: the given
 * toolset's, or both when omitted. A cleared maintenance check starts one
 * maintenance run at once. Answers the Meta agent as it is after the retry.
 */
export function retryMetaAgentGuard(toolset?: MetaAgentToolset): Promise<MetaAgentInfo> {
  return metaAgentJson('/retry', { method: 'POST', body: toolset ? { toolset } : {} });
}
