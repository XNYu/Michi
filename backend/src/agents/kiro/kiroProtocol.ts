/** Kiro engine generations both speak ACP protocol version 1. */
export type KiroEngine = 'v2' | 'v3';

export function resolveKiroEngine(value = process.env.MICHI_KIRO_ENGINE): KiroEngine {
    if (!value || value === 'v2') return 'v2';
    if (value === 'v3') return 'v3';
    throw new Error('MICHI_KIRO_ENGINE must be v2 or v3');
}

export function kiroArgs(engine: KiroEngine, model?: string): string[] {
    return engine === 'v3'
        ? ['acp', '--agent-engine', 'v3', '--auth-method', 'cli']
        : ['acp', '--agent-engine', 'v2', '-a', ...(model ? ['--model', model] : [])];
}

export interface AcpMcpServer {
    name: string;
    type?: 'http' | 'sse';
    url?: string;
    headers?: Array<{ name: string; value: string }>;
    command?: string;
    args?: string[];
    env?: Array<{ name: string; value: string }>;
    _meta?: { kiro?: { waitForReady?: boolean; versionNegotiation?: 'legacy' } };
}

export function michiMcpServer(engine: KiroEngine, baseUrl: string, slotId: string): AcpMcpServer {
    return {
        name: 'michi',
        type: 'http', url: `${baseUrl}/mcp/${slotId}`, headers: [],
        ...(engine === 'v3' ? { _meta: { kiro: { waitForReady: true, versionNegotiation: 'legacy' as const } } } : {}),
    };
}

export interface AcpSessionOptions {
    modelId?: string;
    modeId?: string;
}

export interface AcpConfigValue {
    value: string;
    name?: string;
    description?: string;
    _meta?: Record<string, any>;
}

export interface AcpConfigOption {
    id: string;
    type: string;
    name?: string;
    category?: string;
    currentValue?: string | boolean;
    options?: Array<AcpConfigValue | { group: string; options: AcpConfigValue[] }>;
}

export interface AcpSessionInfo {
    modes?: any;
    models?: any;
    configOptions?: AcpConfigOption[];
}

export interface AcpInitializeResult {
    protocolVersion: number;
    agentInfo?: { name: string; version?: string };
    agentCapabilities?: {
        loadSession?: boolean;
        promptCapabilities?: { image?: boolean; embeddedContext?: boolean; audio?: boolean };
        mcpCapabilities?: { http?: boolean; sse?: boolean };
        sessionCapabilities?: { fork?: object; list?: object; delete?: object };
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
    } } };
}

export interface KiroForkPoint {
    logIndex: number;
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
