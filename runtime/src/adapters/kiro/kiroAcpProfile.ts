import type { AcpPermissionRequest, AcpProfile, AcpSessionInfo, AcpUpdate } from '../acp/types';
import { kiroArgs, kiroEnv, kiroSessionMeta, normalizeSessionInfo, type AcpSessionOptions, type KiroEngine } from './kiroProtocol';

/**
 * Launch override for an ACP agent that speaks Kiro's protocol but is not
 * kiro-cli (e.g. the Kiro Crew adapter). `args` receives the cold-start model.
 */
export interface AcpLaunch {
    bin: string;
    args: (model?: string) => string[];
    /** Cancel watchdog for this agent. Defaults to 5 seconds for kiro-cli. */
    cancelTimeoutMs?: number;
    /** A v2-compatible adapter with standard session/fork (kiro-cli v2 uses rewind). */
    standardFork?: boolean;
}

export interface KiroAcpProfileOptions {
    extraArgs?: string[];
    childEnv?: NodeJS.ProcessEnv;
    /** kiro-cli, or the launch override's binary. */
    binaryPath: string;
    cwd: string;
    model?: string;
    engine?: KiroEngine;
    /** Replaces kiro-cli's argv (and binary: pass launch.bin as binaryPath). */
    launch?: AcpLaunch;
    /** Id of the owning runtime instance ("crew" for Kiro Crew). */
    runtimeId?: string;
    /** See AcpProcessOptions.preloadTools. */
    preloadTools?: () => boolean;
}

/**
 * Kiro's ACP personality: kiro-cli (or a launch override such as Kiro Crew's
 * adapter) spoken to with protocol version 1, Michi's client info, no client
 * capabilities and no authenticate step. Crew keeps Kiro's log label and
 * name, so its logs and errors read like Kiro's.
 */
export class KiroAcpProfile implements AcpProfile {
    readonly runtimeId: string;
    readonly logLabel = 'kiro';
    readonly displayName = 'Kiro';
    readonly binaryPath: string;
    readonly cwd: string;
    readonly model?: string;
    readonly engine: KiroEngine;
    /** Both engine generations speak ACP protocol version 1, and nothing else is accepted. */
    readonly protocolVersion = 1;
    readonly requireProtocolVersion = true;
    readonly clientInfo = { name: 'michi', version: '1.0.0' };
    readonly clientCapabilities = {};
    /** Kiro takes Michi's MCP slot whatever initialize advertises. */
    readonly mcpAttach = 'always' as const;
    readonly cancelTimeoutMs: number;
    private readonly launch?: AcpLaunch;
    private readonly extraArgs: string[];
    private readonly childEnv?: NodeJS.ProcessEnv;
    private readonly preloadTools?: () => boolean;

    constructor(options: KiroAcpProfileOptions) {
        this.runtimeId = options.runtimeId ?? 'kiro';
        this.binaryPath = options.binaryPath;
        this.cwd = options.cwd;
        this.model = options.model;
        this.engine = options.engine ?? 'v2';
        this.launch = options.launch;
        this.extraArgs = options.extraArgs ?? [];
        this.childEnv = options.childEnv;
        this.preloadTools = options.preloadTools;
        this.cancelTimeoutMs = options.launch?.cancelTimeoutMs ?? 5_000;
    }

    /** A launch override resolves its argv at every start. */
    get spawnArgs(): string[] {
        return this.launch ? this.launch.args(this.model) : [...kiroArgs(this.engine, this.model), ...this.extraArgs];
    }

    /** kiroEnv on the host's environment; a launch override's child inherits ours. */
    spawnEnvironment(hostEnv: (() => NodeJS.ProcessEnv) | undefined): NodeJS.ProcessEnv | undefined {
        if (this.launch) return undefined;
        if (this.childEnv) return this.childEnv;
        return hostEnv ? kiroEnv(this.engine, hostEnv(), this.preloadTools?.() ?? true) : undefined;
    }

    /** v3's `_meta.kiro` (model, agent, workflows), then the caller's metadata in `_meta`. */
    sessionParams(kind: 'new' | 'load', options: AcpSessionOptions): Record<string, unknown> {
        if (kind === 'new') return {
            ...kiroSessionMeta(this.engine, { modelId: this.model, ...options }),
            ...(options.metadata ? { _meta: { ...(kiroSessionMeta(this.engine, options)._meta as object), ...options.metadata } } : {}),
        };
        return { ...kiroSessionMeta(this.engine, options), ...(options.metadata ? { _meta: { ...(kiroSessionMeta(this.engine, options)._meta as object), ...options.metadata } } : {}) };
    }

    /** v3's config options also answer as modes and models. */
    normalizeSessionInfo(info: AcpSessionInfo): AcpSessionInfo {
        return normalizeSessionInfo(info);
    }

    /** v3 reports its own usage summary (source kiro-v3); v2's metering usage takes the core's default. */
    usageSummary(buffered: Record<string, any> | undefined): AcpUpdate | undefined {
        return this.engine === 'v3' && buffered?.source === 'kiro-v3' ? { ...buffered, sessionUpdate: 'usage_summary' } : undefined;
    }

    /** v3 consent of an "always" answer, kept to this session and the exact resource. */
    permissionResultMeta(pending: AcpPermissionRequest, optionId: string): Record<string, unknown> {
        const option = pending.options?.find((option) => option.optionId === optionId);
        const consent = pending.meta?.kiro?.consent;
        if (this.engine !== 'v3' || !consent || !['allow_always', 'reject_always'].includes(option?.kind)) return {};
        // Limit provider persistence to this session and the exact triggering
        // resource, never infer a wildcard grant from a tool's display title.
        return { _meta: { kiro: { consent: { capability: consent.capability, scope: 'session',
            resource: consent.triggeringResource ?? consent.resource, workspaceRoot: consent.workspaceRoot,
        } } } };
    }
}
