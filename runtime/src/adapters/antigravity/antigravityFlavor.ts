import type { KiroFlavor } from '../kiro/kiroFlavor';
import { isHeadlessOwner } from '../kiro/kiroOwner';

/** agy names a tool of an MCP server `<server>` as `mcp_<server>_<tool>`; Michi's server is `michi`. */
const MICHI_TOOL_PREFIX = 'mcp_michi_';
/** agy's title for an MCP tool call: `Run mcp_<server>_<tool>`. */
const MICHI_TOOL_TITLE = /^Run mcp_michi_(.+)$/;

function michiToolName(update: Record<string, any>): string | undefined {
    const name = update.name;
    if (typeof name === 'string' && name.startsWith(MICHI_TOOL_PREFIX) && name.length > MICHI_TOOL_PREFIX.length) {
        return name.slice(MICHI_TOOL_PREFIX.length);
    }
    return typeof update.title === 'string' ? MICHI_TOOL_TITLE.exec(update.title)?.[1] : undefined;
}

/** agy 1.4.12 answers session/new, session/prompt and session/list this way while signed out. */
function isAuthenticationRequired(error: { code?: number; message?: string } | string): boolean {
    if (typeof error === 'string') return /authentication required/i.test(error);
    return error.code === -32000 && /authentication required/i.test(error.message ?? '');
}

/**
 * Antigravity's `agy acp` as a flavor of the Kiro runtime. It takes Michi's
 * stable instructions as its system prompt (session/new
 * `_meta.antigravity.systemPrompt.append`, kept across session/load), so a
 * chat's first message carries only the host's variable prefix; its turn
 * metadata goes through Michi's tools. A chat's system prompt is its own, so
 * no session opens ahead of a chat. agy titles sessions natively, drops
 * image blocks but reads image files, names Michi's tools `mcp_michi_<tool>`,
 * and settles a cancelled prompt at once. A lost native session is rebuilt
 * from the host's history. It reports token usage, not metering.
 */
export const ANTIGRAVITY_KIRO_FLAVOR: KiroFlavor = {
    hostPorts: [],
    prompt: {
        firstMessage: (host, input) => host.prompt.firstTurnPrefix(input),
        metadataChannel: 'tools',
    },
    sessionInfoEvents: (update) => typeof update.title === 'string' && update.title.trim()
        ? [{ kind: 'title', title: update.title.trim() }] : [],
    nativeSessions: { replaceable: true },
    promptImages: 'resourceLink',
    warmSessions: false,
    tools: {
        title: michiToolName,
        name: (toolCall) => typeof toolCall?.name === 'string' ? toolCall.name : undefined,
    },
    signIn: {
        matches: isAuthenticationRequired,
        message: 'Antigravity is not signed in. Run `agy` in a terminal and sign in with Google, then try again.',
    },
    sessionAnchors: false,
    cancelAck: { kind: 'prompt-settlement' },
    metersUsage: false,
    sessionMetadata(host, opts) {
        // Agent Runs bring their own instructions.
        if (isHeadlessOwner(opts.owner)) return undefined;
        // The head of Kiro's preamble: sentinel metadata mode, the chat's follow-ups and tool profile.
        // agy's own ask_question reaches Michi's question card through elicitation, so
        // the native-ask note applies rather than the note that forbids built-in questions.
        const append = host.prompt.stableSystemPrompt(
            'sentinel', opts.enableFollowUps !== false, true, host.profile.isRestricted(opts.toolProfile), opts.toolProfile,
        );
        return append ? { antigravity: { systemPrompt: { append } } } : undefined;
    },
};
