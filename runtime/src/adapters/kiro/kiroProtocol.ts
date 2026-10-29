import type { McpHttpEndpoint } from '../../contract/mcp';
import type {
    AcpConfigOption, AcpConfigValue, AcpSessionInfo,
    AcpMcpServer as AcpCoreMcpServer, AcpSessionOptions as AcpCoreSessionOptions,
} from '../acp/types';

export type { AcpConfigOption, AcpConfigValue, AcpSessionInfo } from '../acp/types';

/** Reply for a Kiro turn whose last step was set_branch_overview. An ACP
 *  turn needs a non-empty model response after that tool result; the
 *  convention is declared in the host's per-turn reminder
 *  (PromptPolicyPort.turnSuffix), not in the tool result, and KiroSession's
 *  TrailingSentinelStripper removes it. */
export const KIRO_METADATA_DONE_SENTINEL = "[MICHI_METADATA_DONE]";

/** Kiro engine generations both speak ACP protocol version 1. */
export type KiroEngine = 'v2' | 'v3';

/** The engine named by `value` (Michi: MICHI_KIRO_ENGINE); unset is v3. */
export function resolveKiroEngine(value: string | undefined): KiroEngine {
    if (!value || value === 'v3') return 'v3';
    if (value === 'v2') return 'v2';
    throw new Error('MICHI_KIRO_ENGINE must be v2 or v3');
}

/**
 * Kiro V3's "Approve for me" policy preset: workspace edits and read-only
 * shell are allowed, and its trust classifier judges what no rule settles
 * (approve, or fall back to asking). Seeded only by session/new and
 * session/load (`_meta.kiro.policyPreset`).
 */
export const KIRO_APPROVE_FOR_ME_PRESET = 'approve-for-me';

/**
 * kiro-cli 2.35 drops a classifier preset unless its process runs the trust
 * classifier in enforce mode. The classifier runs only for a rule whose
 * effect is `evaluate`, so a session without such a preset or rule is not
 * judged by it.
 */
const KIRO_TRUST_CLASSIFIER_ENV = 'KIRO_TRUST_CLASSIFIER_MODE';

export function kiroArgs(engine: KiroEngine, model?: string): string[] {
    return engine === 'v3'
        ? ['acp', '--agent-engine', 'v3', '--auth-method', 'cli']
        : ['acp', '--agent-engine', 'v2', ...(model ? ['--model', model] : [])];
}

/** Preserve caller settings; enable V3 policy classification when unspecified. */
export function kiroEnv(engine: KiroEngine, env: NodeJS.ProcessEnv, _preloadTools = true): NodeJS.ProcessEnv {
    const classifier = engine === 'v3' && !env[KIRO_TRUST_CLASSIFIER_ENV]?.trim()
        ? { [KIRO_TRUST_CLASSIFIER_ENV]: 'enforce' } : {};
    return { ...env, ...classifier };
}

/** An ACP MCP server entry with Kiro's `_meta`. */
export interface AcpMcpServer extends AcpCoreMcpServer {
    _meta?: { kiro?: { waitForReady?: boolean; versionNegotiation?: 'legacy' } };
}

/**
 * Kiro's entry for Michi's MCP server at `endpoint`, a URL of the host's slot
 * provider (McpSlotProvider.endpoint, or sessionEndpoint for a chat group).
 * Kiro takes no authentication headers here, and v3 waits for the server
 * before the first prompt.
 */
export function michiMcpServer(engine: KiroEngine, endpoint: McpHttpEndpoint): AcpMcpServer {
    return {
        name: 'michi',
        type: endpoint.type, url: endpoint.url, headers: [],
        ...(engine === 'v3' ? { _meta: { kiro: { waitForReady: true, versionNegotiation: 'legacy' as const } } } : {}),
    };
}

/** One definition per cwd/process (McpSlotProvider.sessionEndpoint); session_id is carried in each tool call. */
export function michiSessionMcpServer(endpoint: McpHttpEndpoint): AcpMcpServer {
    return michiMcpServer('v3', endpoint);
}

export interface AcpSessionOptions extends AcpCoreSessionOptions {
    /** Opt this session into Kiro workflows (V3 `_kiro/workflow/*`). */
    workflowsEnabled?: boolean;
    /** V3 policy presets seeded into the session (KIRO_APPROVE_FOR_ME_PRESET). */
    policyPresets?: readonly string[];
}

export interface AcpInitializeResult {
    protocolVersion: number;
    agentInfo?: { name: string; version?: string };
    agentCapabilities?: {
        loadSession?: boolean;
        promptCapabilities?: { image?: boolean; embeddedContext?: boolean; audio?: boolean };
        mcpCapabilities?: { http?: boolean; sse?: boolean };
        sessionCapabilities?: { fork?: object; list?: object; delete?: object; close?: object };
        _meta?: { kiro?: { extensionMethods?: string[]; [key: string]: unknown } };
    };
    authMethods?: unknown[];
}

export function configValues(option?: AcpConfigOption): AcpConfigValue[] {
    return (option?.options ?? []).flatMap((value) => 'group' in value ? value.options : [value])
        .filter((value) => typeof value?.value === 'string');
}

/** Adapt v3's dynamic config catalog to the existing runtime mode/model contract. */
export function normalizeSessionInfo(result: AcpSessionInfo): AcpSessionInfo {
    if (!Array.isArray(result.configOptions)) return result;
    const model = result.configOptions.find((c) => c.id === 'model' || c.category === 'model');
    const mode = result.configOptions.find((c) => c.id === 'mode' || c.category === 'mode');
    return {
        ...result,
        ...(model ? { models: {
            currentModelId: model.currentValue,
            availableModels: configValues(model).map((v) => ({ ...v, modelId: v.value })),
        } } : {}),
        ...(mode ? { modes: {
            currentModeId: mode.currentValue,
            availableModes: configValues(mode).map((v) => ({ ...v, id: v.value })),
        } } : {}),
    };
}

export function kiroSessionMeta(engine: KiroEngine, options: AcpSessionOptions): Record<string, unknown> {
    if (engine === 'v2') return {};
    return { _meta: { kiro: {
        ...(options.modelId ? { modelId: options.modelId } : {}),
        ...(options.modeId ? { modeId: options.modeId } : {}),
        ...(options.workflowsEnabled ? { settings: { workflows: { enabled: true } } } : {}),
        ...(options.policyPresets?.length ? { policyPreset: [...options.policyPresets] } : {}),
    } } };
}

export interface KiroForkPoint {
    logIndex: number;
    /** Optional stable row identity supplied by the Crew Gateway adapter. */
    messageId?: string;
    label?: string;
    responseSnippet?: string;
}

export function rewindPoints(result: any): KiroForkPoint[] {
    const rows = result?.data?.turns ?? result?.turns;
    if (!Array.isArray(rows)) throw new Error('Kiro rewind returned no turn catalog');
    // A malformed index must never coerce to 0 and fork the wrong turn.
    return rows.filter((row) => typeof row?.logIndex === 'number'
        && Number.isSafeInteger(row.logIndex) && row.logIndex >= 0);
}

export function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Missing metrics stay missing; credits are not dollar cost. */
export function v3InfoUpdates(update: Record<string, any>): Record<string, any>[] {
    const meta = update._meta?.kiro;
    if (!meta || update.sessionUpdate !== 'session_info_update') return [];
    const result: Record<string, any>[] = [];
    const percentage = finiteNumber(meta.contextUsage?.usagePercentage);
    if (percentage !== undefined) result.push({ sessionUpdate: 'context_usage', contextUsagePercentage: percentage });
    if (meta.kind === 'turn_completion') {
        const summaries = Array.isArray(meta.promptTurnSummaries) ? meta.promptTurnSummaries : [];
        const credits = summaries.filter((row: any) => row.unit === 'credit' || row.unitPlural === 'credits')
            .map((row: any) => finiteNumber(row.usage)).filter((n: unknown): n is number => n !== undefined);
        result.push({ sessionUpdate: 'usage_summary',
            ...(credits.length ? { totalCredits: credits.reduce((a: number, b: number) => a + b, 0) } : {}),
            ...(finiteNumber(meta.elapsedTime) !== undefined ? { turnDurationMs: meta.elapsedTime } : {}),
            source: 'kiro-v3',
        });
    }
    if (meta.kind === 'display_error') {
        const error = meta.displayError ?? meta;
        const message = typeof error.message === 'string' ? error.message : 'Kiro reported an error';
        result.push(error.errorType === 'mcp_connection_error'
            ? { sessionUpdate: 'mcp_server_error', serverName: '', error: message }
            : { sessionUpdate: 'runtime_error', error: message });
    }
    // turn_end notifications are corroboration only; session/prompt settles the turn.
    return result;
}
