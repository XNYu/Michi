/**
 * Pure helpers for the Crew ACP server: translating Gateway chat frames into
 * ACP `session/update` payloads, and keeping JSON-RPC error text away from the
 * substrings Michi reads as process death.
 */

import type { CrewChatFrame } from './gatewayTypes';

export type AcpUpdate = Record<string, unknown> & { sessionUpdate: string };

export const TOOL_TITLE_MAX = 120;
export const TOOL_CONTENT_MAX = 16_000;

export const RECEIPT_NOTICE =
    '\n\n> Kiro Crew is still running an earlier message in this session, so this one was ' +
    'queued there and will run next. See the Kiro Crew dashboard.\n\n';

/** Frame `content` as text: strings pass through, other values are JSON-encoded. */
export function frameText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (content === undefined || content === null) return '';
    try {
        return JSON.stringify(content) ?? '';
    } catch {
        return String(content);
    }
}

function isThinking(cls: unknown): boolean {
    if (typeof cls === 'string') return cls.includes('thinking');
    if (Array.isArray(cls)) return cls.some((c) => typeof c === 'string' && c.includes('thinking'));
    return false;
}

function textChunk(kind: 'agent_message_chunk' | 'agent_thought_chunk', text: string): AcpUpdate {
    return { sessionUpdate: kind, content: { type: 'text', text } };
}

function firstLine(text: string): string {
    return text.split('\n', 1)[0].trim();
}

export function messageNotice(text: string): AcpUpdate {
    return textChunk('agent_message_chunk', text);
}

function permissionNotice(frame: CrewChatFrame, text: string, dashboardUrl?: string): AcpUpdate {
    const metaTitle = frame.meta?.tool_title;
    const title = ((typeof metaTitle === 'string' && metaTitle.trim()) || firstLine(text) || 'A tool call')
        .slice(0, TOOL_TITLE_MAX).replace(/[\\`*_[\]<>]/g, '\\$&');
    return messageNotice(
        `\n\n> **Approval needed:** ${title}. The approval is pending in ${dashboardUrl ? `[the Kiro Crew dashboard](${dashboardUrl})` : 'the Kiro Crew dashboard'}. ` +
            'Unanswered approvals are declined after about 3 minutes.\n\n',
    );
}

/**
 * Translate one Gateway frame. Returns null for frames Michi should not see
 * (`assistant` repeats the streamed chunks; `system`, `user`, `done` and
 * unknown types carry nothing to render). Tool rows are joined by CrewTurn.
 */
export function translateFrame(frame: CrewChatFrame, dashboardUrl?: string): AcpUpdate | null {
    const text = frameText(frame.content);
    switch (frame.type) {
        case 'chunk':
            if (!text) return null;
            return textChunk(isThinking(frame.cls) ? 'agent_thought_chunk' : 'agent_message_chunk', text);
        case 'permission':
            return permissionNotice(frame, text, dashboardUrl);
        case 'error':
            return messageNotice(`\n\n**Crew error:** ${text}\n`);
        case 'compacting':
            return textChunk('agent_thought_chunk', 'Compacting conversation…');
        case 'notice':
            return text ? textChunk('agent_thought_chunk', text) : null;
        default:
            return null;
    }
}

/**
 * Michi classifies ACP errors by substring (backend/src/agents/kiro/acpErrors.ts).
 * Connection-class markers make it kill the shared adapter process and every
 * session on that cwd, so rewrite them before an error leaves this process.
 */
const CONNECTION_MARKER_REWRITES: Array<[RegExp, string]> = [
    [/timed\s*out/gi, 'took too long'],
    [/timeout\s*error/gi, 'timeout failure'],
    [/response\s*stream/gi, 'reply stream'],
    [/connection\s*reset/gi, 'connection dropped'],
    [/econnreset/gi, 'connection dropped'],
    [/dispatch\s*failure/gi, 'dispatch problem'],
    [/stalled\s*stream/gi, 'stalled reply'],
    [/host\s*unreachable/gi, 'host not reachable'],
    [/response\s*error/gi, 'reply error'],
];

export function sanitizeErrorMessage(message: string): string {
    return CONNECTION_MARKER_REWRITES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), message);
}

export function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message || err.name;
    return typeof err === 'string' ? err : frameText(err) || 'unknown error';
}
