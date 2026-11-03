import type {
    AcpHandlerContext, AcpIncomingRequest, AcpPermissionRequest, AcpProfile, AcpSessionInfo, AcpUpdate, AcpUserAnswer,
} from '../acp/types';
import type { UserInputQuestion } from '../../contract/events';
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
    /**
     * The agent speaks standard ACP only, none of kiro-cli's extensions
     * (`_kiro.dev/*`, `_kiro/*`, `_session/*`), e.g. Antigravity's `agy acp`.
     * Then no extension is sent: commands, compaction and steering answer as
     * unsupported; the model and reasoning go through the session's `model`
     * and `thought_level` config options; session/load is preceded by a
     * session/list check; a released session gets session/close; and the
     * prompt result's `usage` becomes a token usage summary. Default false.
     */
    standardAcp?: boolean;
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
    /** The agent's name in user-visible errors, for a standardAcp launch only. Default (and otherwise): Kiro. */
    displayName?: string;
}

/** Elicitation questions take user-input ids from here up, apart from the runtime's own ask_user ids. */
export const ELICITATION_REQUEST_ID_BASE = 1_000_000_000;

/**
 * Kiro's ACP personality: kiro-cli (or a launch override such as Kiro Crew's
 * adapter) spoken to with protocol version 1, Michi's client info, no client
 * capabilities and no authenticate step. Crew keeps Kiro's log label and
 * name, so its logs and errors read like Kiro's. A standardAcp launch
 * advertises form elicitation and answers it with Michi's user-input card.
 */
export class KiroAcpProfile implements AcpProfile {
    readonly runtimeId: string;
    readonly logLabel = 'kiro';
    readonly displayName: string;
    readonly binaryPath: string;
    readonly cwd: string;
    readonly model?: string;
    readonly engine: KiroEngine;
    /** Both engine generations speak ACP protocol version 1, and nothing else is accepted. */
    readonly protocolVersion = 1;
    readonly requireProtocolVersion = true;
    readonly clientInfo = { name: 'michi', version: '1.0.0' };
    readonly clientCapabilities: Record<string, unknown>;
    /** Kiro takes Michi's MCP slot whatever initialize advertises. */
    readonly mcpAttach = 'always' as const;
    readonly cancelTimeoutMs: number;
    /**
     * Only for a standardAcp launch: without the hook the client refuses an
     * agent's request at once, as it always has for kiro-cli.
     */
    readonly handleIncomingRequest?: (msg: AcpIncomingRequest, ctx: AcpHandlerContext) => Promise<boolean>;
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
        const standardAcp = options.launch?.standardAcp === true;
        this.displayName = standardAcp && options.displayName ? options.displayName : 'Kiro';
        this.clientCapabilities = standardAcp ? { elicitation: { form: {} } } : {};
        if (standardAcp) {
            this.handleIncomingRequest = async (msg, ctx) => {
                if (msg.method !== 'elicitation/create') return false;
                await answerElicitation(msg, ctx);
                return true;
            };
        }
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

    /**
     * v3 reports its own usage summary (source kiro-v3); v2's metering usage
     * takes the core's default. A standardAcp agent's prompt result carries
     * token counts (source acp), whatever its stop reason.
     */
    usageSummary(buffered: Record<string, any> | undefined, promptResult?: Record<string, any>): AcpUpdate | undefined {
        if (this.launch?.standardAcp) return promptTokenUsage(promptResult?.usage);
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

/** ACP's prompt-result usage names, by the usage_summary field each fills. */
const PROMPT_USAGE_FIELDS = {
    inputTokens: 'inputTokens',
    outputTokens: 'outputTokens',
    cachedInputTokens: 'cachedReadTokens',
    reasoningOutputTokens: 'thoughtTokens',
    totalTokens: 'totalTokens',
} as const;

function promptTokenUsage(usage: unknown): AcpUpdate | undefined {
    if (!usage || typeof usage !== 'object') return undefined;
    const tokens: Record<string, number> = {};
    for (const [field, name] of Object.entries(PROMPT_USAGE_FIELDS)) {
        const value = (usage as Record<string, unknown>)[name];
        if (typeof value === 'number' && Number.isFinite(value)) tokens[field] = value;
    }
    return Object.keys(tokens).length ? { sessionUpdate: 'usage_summary', source: 'acp', ...tokens } : undefined;
}

/** One question of a form elicitation: a schema property, and its `<key>_other` free-text companion. */
interface ElicitationField {
    key: string;
    otherKey?: string;
    type: 'string' | 'array' | 'boolean' | 'number' | 'integer';
    choices: Array<{ value: string | boolean; label: string }>;
    question: UserInputQuestion;
}

function schemaChoices(schema: Record<string, any>): Array<{ value: string; label: string }> {
    const listed = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
    if (listed) {
        return listed.filter((choice: any) => typeof choice?.const === 'string')
            .map((choice: any) => ({ value: choice.const, label: typeof choice.title === 'string' && choice.title ? choice.title : choice.const }));
    }
    if (!Array.isArray(schema.enum)) return [];
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.filter((value: unknown): value is string => typeof value === 'string')
        .map((value: string, index: number) => ({ value, label: typeof names[index] === 'string' && names[index] ? names[index] : value }));
}

function elicitationFields(params: Record<string, any>): ElicitationField[] {
    const properties = params.requestedSchema?.properties;
    if (!properties || typeof properties !== 'object') return [];
    const keys = Object.keys(properties);
    const others = new Set(keys.filter((key) => key.endsWith('_other') && keys.includes(key.slice(0, -'_other'.length))));
    const fields: ElicitationField[] = [];
    for (const key of keys) {
        if (others.has(key)) continue;
        const schema = properties[key] ?? {};
        const type = ['array', 'boolean', 'number', 'integer'].includes(schema.type) ? schema.type : 'string';
        const choices: ElicitationField['choices'] = type === 'array' ? schemaChoices(schema.items ?? {})
            : type === 'boolean' ? [{ value: true, label: 'Yes' }, { value: false, label: 'No' }]
                : type === 'string' ? schemaChoices(schema) : [];
        const title = typeof schema.title === 'string' && schema.title ? schema.title
            : typeof schema.description === 'string' && schema.description ? schema.description : undefined;
        fields.push({
            key,
            ...(others.has(`${key}_other`) ? { otherKey: `${key}_other` } : {}),
            type,
            choices,
            question: {
                question: title ?? (typeof params.message === 'string' && params.message ? params.message : key),
                options: choices.map((choice) => ({ label: choice.label })),
                multiSelect: type === 'array',
            },
        });
    }
    return fields;
}

/**
 * Michi's card answers with the chosen labels and any typed text joined by
 * ", "; a label may itself contain ", ", so the longest run that names one wins.
 */
function splitAnswer(answer: string, labels: string[]): { chosen: string[]; rest: string } {
    const parts = answer.split(', ');
    const chosen: string[] = [];
    const rest: string[] = [];
    for (let i = 0; i < parts.length;) {
        let end = parts.length;
        while (end > i && !labels.includes(parts.slice(i, end).join(', '))) end--;
        if (end > i) {
            chosen.push(parts.slice(i, end).join(', '));
            i = end;
        } else rest.push(parts[i++]);
    }
    return { chosen, rest: rest.join(', ').trim() };
}

function elicitationContent(fields: ElicitationField[], answers: AcpUserAnswer[]): Record<string, unknown> {
    const content: Record<string, unknown> = {};
    fields.forEach((field, index) => {
        const entry = answers[index]?.question === field.question.question ? answers[index]
            : answers.find((candidate) => candidate.question === field.question.question) ?? answers[index];
        const answer = typeof entry?.answer === 'string' ? entry.answer.trim() : '';
        if (!answer) return;
        if (field.type === 'number' || field.type === 'integer') {
            const value = Number(answer);
            content[field.key] = Number.isFinite(value) ? value : answer;
            return;
        }
        const { chosen, rest } = splitAnswer(answer, field.choices.map((choice) => choice.label));
        const values = chosen.map((label) => field.choices.find((choice) => choice.label === label)!.value);
        if (field.type === 'array') content[field.key] = values;
        else if (values.length) content[field.key] = values[0];
        const text = [...(field.type === 'array' ? [] : chosen.slice(1)), ...(rest ? [rest] : [])].join(', ');
        if (!text) return;
        if (field.otherKey) content[field.otherKey] = text;
        else if (!values.length && field.type === 'string') content[field.key] = text;
    });
    return content;
}

/**
 * ACP `elicitation/create` in form mode (agy's ask_question): shown as
 * Michi's user-input card, answered `accept` with the chosen values (typed
 * text in `<key>_other` when the form has one), or `cancel` when the user
 * skips it, the turn ends, or nothing can show it.
 */
async function answerElicitation(msg: AcpIncomingRequest, ctx: AcpHandlerContext): Promise<void> {
    const params = msg.params ?? {};
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    const fields = params.mode === undefined || params.mode === 'form' ? elicitationFields(params) : [];
    if (!sessionId || !ctx.hasSession(sessionId) || fields.length === 0) {
        ctx.reply(msg.id, { action: 'cancel' });
        return;
    }
    const requestId = ELICITATION_REQUEST_ID_BASE + ctx.nextUserInputRequestId();
    ctx.pushUpdate(sessionId, { sessionUpdate: 'user_input_request', requestId, questions: fields.map((field) => field.question) });
    const answers = await ctx.waitForUserInput(requestId, sessionId);
    ctx.pushUpdate(sessionId, { sessionUpdate: 'user_input_resolved', requestId, answers: answers ?? [] });
    ctx.reply(msg.id, answers ? { action: 'accept', content: elicitationContent(fields, answers) } : { action: 'cancel' });
}
