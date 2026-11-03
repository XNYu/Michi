// Kiro's permission tool names: where an ACP request names its tool, and
// Michi's canonical name for it.

/** How an agent names a tool call itself (AcpAgentFlavor.tools.name); undefined: it does not. */
export type KiroToolNameResolver = (toolCall: Record<string, any> | undefined) => string | undefined;

/** ACP titles can be prose. Only the agent's own name for the call, explicit
 * provider metadata or known exact built-in identifiers can become a
 * reusable tool grant. */
export function acpPermissionToolName(toolCall: any, meta?: any, resolveName?: KiroToolNameResolver): string | undefined {
    return agentToolName(toolCall, resolveName) ?? providerToolName(toolCall, meta) ?? builtinTitle(toolCall);
}

function agentToolName(toolCall: any, resolveName?: KiroToolNameResolver): string | undefined {
    const name = resolveName?.(toolCall);
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function providerToolName(toolCall: any, meta?: any): string | undefined {
    const name = meta?.toolName ?? toolCall?._meta?.toolName;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function builtinTitle(toolCall: any): string | undefined {
    const title = toolCall?.title;
    return typeof title === 'string' && ACP_BUILTIN_TOOL_NAMES.has(title) ? title : undefined;
}

/** Kiro v3's tool identifier, set by kiro-cli rather than by the model. */
function kiroToolId(meta?: any): string | undefined {
    const toolId = meta?.kiro?.toolId;
    return typeof toolId === 'string' && toolId.trim() ? toolId.trim() : undefined;
}

const ACP_BUILTIN_TOOL_NAMES = new Set([
    'read', 'write', 'edit', 'bash', 'Bash', 'Read', 'Write', 'Edit',
    'fs_read', 'fs_write', 'execute_bash', 'use_aws',
    '@michi/send_to_thread',
]);

/**
 * Kiro's built-in tools under Michi's names. run_command is v3's shell tool
 * (its consent capability is "shell"); shell, read and write are v2's
 * built-ins as its tool_call updates name them. The PascalCase names include
 * the aliases RuntimeRunExecutor applied itself before adapters sent
 * canonical names, and Read, which it never mapped. The snake_case file and
 * search tools are Antigravity's (agy 1.4.12), whose run_command is its
 * shell tool too. use_aws and every other name stay as they are.
 */
const CANONICAL_NAMES = new Map([
    ['fs_read', 'read'],
    ['fs_write', 'write'],
    ['execute_bash', 'bash'],
    ['run_command', 'bash'],
    ['shell', 'bash'],
    ['read', 'read'],
    ['write', 'write'],
    ['Read', 'read'],
    ['Bash', 'bash'],
    ['Edit', 'edit'],
    ['MultiEdit', 'edit'],
    ['NotebookEdit', 'edit'],
    ['Write', 'write'],
    ['write_file', 'write'],
    ['replace_file_content', 'edit'],
    ['multi_replace_file_content', 'edit'],
    ['read_file', 'read'],
    ['view_file', 'read'],
    ['list_dir', 'ls'],
    ['find_by_name', 'find'],
    ['grep_search', 'grep'],
]);

/**
 * The name the Agent Run permission broker receives. Chat grants keep the
 * name Kiro sent (acpPermissionToolName), so grants users already saved
 * still match.
 */
export function canonicalKiroToolName(toolName: string): string {
    return CANONICAL_NAMES.get(toolName) ?? toolName;
}

/**
 * The name the Agent Run permission broker receives: canonical, or
 * "unknown" when the request names no tool (never its prose title). The
 * sources in order: the agent's own name for the call (resolveName),
 * explicit provider metadata, Kiro v3's `_meta.kiro.toolId`, the name the
 * call's tool_call update gave it (`calledAs`, see KiroToolCallNames) when
 * that is a Kiro built-in, then a title that is exactly a built-in name.
 * Tool ids and update names come before the title because a shell request
 * is titled with its command (v3) or a description (v2), which may itself be
 * a built-in name such as `write`. Any other update name falls back to the
 * title, as before.
 */
export function kiroBrokerToolName(toolCall: any, meta?: any, calledAs?: string, resolveName?: KiroToolNameResolver): string {
    const name = agentToolName(toolCall, resolveName) ?? providerToolName(toolCall, meta) ?? kiroToolId(meta)
        ?? kiroBuiltinName(calledAs) ?? builtinTitle(toolCall);
    return name ? canonicalKiroToolName(name) : 'unknown';
}

function kiroBuiltinName(name: string | undefined): string | undefined {
    return name !== undefined && CANONICAL_NAMES.has(name) ? name : undefined;
}

/** How many tool calls of one turn KiroToolCallNames keeps. */
const TOOL_CALL_NAMES_PER_TURN = 256;

/**
 * The names kiro-cli gave one turn's tool calls in their tool_call updates
 * (`_meta.kiro.toolName`), by toolCallId. kiro-cli 2.34.0 v2 sends that
 * update before the call's request_permission, which names the tool
 * nowhere. Only kiro-cli writes the field, as it does v3's tool id. An agent
 * that names its calls itself (resolveName) is read first. Keeps the newest
 * TOOL_CALL_NAMES_PER_TURN calls; a turn starts with none.
 */
export class KiroToolCallNames {
    private readonly names = new Map<string, string>();

    constructor(private readonly limit = TOOL_CALL_NAMES_PER_TURN, private readonly resolveName?: KiroToolNameResolver) {}

    /** A tool_call or tool_call_update; one without a name changes nothing. */
    remember(update: any): void {
        const toolCallId = update?.toolCallId;
        const name = agentToolName(update, this.resolveName) ?? update?._meta?.kiro?.toolName;
        if (typeof toolCallId !== 'string' || !toolCallId || typeof name !== 'string' || !name.trim()) return;
        this.names.delete(toolCallId);
        this.names.set(toolCallId, name.trim());
        if (this.names.size > this.limit) this.names.delete(this.names.keys().next().value!);
    }

    get(toolCallId: unknown): string | undefined {
        return typeof toolCallId === 'string' ? this.names.get(toolCallId) : undefined;
    }
}
