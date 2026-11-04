/**
 * The Meta agent: one agent with two kinds of run. Background maintenance
 * reads newly completed conversations and writes Space pages; the Spaces chat
 * window talks with the user. Both share one settings record. Background
 * maintenance uses checked tool access; interactive chat uses ordinary tools.
 *
 * Backend: GET /api/meta-agent, PUT /api/meta-agent/settings,
 * POST /api/meta-agent/retry.
 */

import type { RuntimeReasoning } from './reasoning';

/** Every runtime the Meta agent can be configured to use. */
export const META_AGENT_RUNTIMES = ['claude', 'pi', 'codex', 'kiro', 'crew'] as const;

/** How many days of history a workspace's first read covers. */
export const META_AGENT_FIRST_RUN_DAYS = [7, 30, 90] as const;
export type MetaAgentFirstRunDays = typeof META_AGENT_FIRST_RUN_DAYS[number];
export const META_AGENT_DEFAULT_FIRST_RUN_DAYS: MetaAgentFirstRunDays = 30;

/**
 * The one stored Meta agent settings record. A null runtime field follows the
 * global runtime settings at the start of each run; it is never snapshotted.
 * When `runtimeId` is null the other runtime fields are ignored and the whole
 * global profile is used.
 *
 * The reading and writing fields are independent of the runtime; null (or
 * absent, from an older backend) means the default.
 */
export interface MetaAgentSettings {
  runtimeId: string | null;
  providerId: string | null;
  modelId: string | null;
  reasoning: RuntimeReasoning | null;
  /** Background runs write workspace home pages; default on. The chat window can always edit them on request. */
  writeWorkspaceHomes?: boolean | null;
  /** Background runs keep the global part of the Spaces Home; default on. */
  maintainSpacesHome?: boolean | null;
  /** Days of history a first read covers; default 30. A first run keeps the range it was queued with. */
  firstRunDays?: MetaAgentFirstRunDays | null;
}

/** PUT /api/meta-agent/settings. Omitted fields keep their value; null means follow global. */
export type MetaAgentSettingsPatch = Partial<MetaAgentSettings>;

/** What a run starting now would use, resolved from MetaAgentSettings and the global settings. */
export interface MetaAgentResolvedRuntime {
  runtimeId: string;
  providerId: string | null;
  modelId: string | null;
  reasoning: RuntimeReasoning | null;
  /** True when runtimeId came from the global settings. */
  followsGlobal: boolean;
}

/** Which closed toolset a run uses; memory is automatic memory extraction. */
export type MetaAgentToolset = 'maintenance' | 'chat' | 'memory';

/**
 * `code` of the chat stream `error` frame that ends a Meta agent turn stopped
 * by its restriction check.
 */
export const META_AGENT_GUARD_ERROR_CODE = 'meta_agent_guard_failed';

/**
 * The last restriction check outcome for one runtime and toolset. A failed
 * maintenance check holds scheduled maintenance until a retry, or until the
 * resolved runtime profile changes; either clears it.
 */
export interface MetaAgentGuardStatus {
  state: 'ok' | 'failed';
  runtimeId: string;
  toolset: MetaAgentToolset;
  /** Tools the runtime exposed outside the allow-list; empty when ok. */
  unexpectedTools: string[];
  detail?: string;
  checkedAt: number;
}

/** POST /api/meta-agent/retry. Omitting `toolset` clears both. */
export interface MetaAgentRetryRequest {
  toolset?: MetaAgentToolset;
}

/** GET /api/meta-agent and the answer of PUT /api/meta-agent/settings and POST /api/meta-agent/retry. */
export interface MetaAgentInfo {
  settings: MetaAgentSettings;
  resolved: MetaAgentResolvedRuntime;
  /** Whether the Meta agent can run on the resolved runtime. When not, runs stop; they never switch runtimes. */
  availability: { available: boolean; reason: string | null };
  /** Latest check per toolset; null before the first run. */
  guard: { maintenance: MetaAgentGuardStatus | null; chat: MetaAgentGuardStatus | null };
  /** Background maintenance since local midnight; null when it could not be counted (absent from an older backend). */
  usageToday?: MetaAgentUsageToday | null;
  toolApprovals?: MetaAgentToolApproval[];
}

export interface MetaAgentUsageToday {
  /** Maintenance runs started, including those that found nothing new. */
  checks: number;
  /** Runs that opened a model session. */
  modelCalls: number;
  /** Tokens the runtimes reported for those sessions; null when none reported a count. */
  tokens: number | null;
}

/** Persistent permission for one external tool definition and connection configuration. */
export interface MetaAgentToolApproval {
  id: string;
  server: string;
  tool: string;
  description: string;
  state: 'pending' | 'approved' | 'denied' | 'revoked';
  requestedAt: number;
  updatedAt: number;
}
