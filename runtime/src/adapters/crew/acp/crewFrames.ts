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
 * Michi classifies ACP errors by substring (runtime/src/adapters/kiro/acpErrors.ts).
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

type HistoryRow = { role?: unknown; content?: unknown; cls?: unknown; meta?: Record<string, unknown> };

/** The Gateway's terminal stop states (`stop_event` rows, dashboard/chat_api/turn_stop.py). */
const STOP_DONE = new Set(['stopped', 'stop_failed_reset']);

export interface CrewStopReport {
    /** The Gateway recorded that it stopped the turn (soft, or by resetting the session). */
    confirmed: boolean;
    state?: string;
    outcome?: string;
}

/**
 * The newest `stop_event` system row a stop requested at `since` (epoch ms)
 * opened. `stopped` (outcome `soft`) and `stop_failed_reset` confirm the stop;
 * `stopping` is still open and `stop_declined_compacting` stopped nothing.
 */
export function stopReport(rows: readonly HistoryRow[], since: number): CrewStopReport | undefined {
    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.role !== 'system' || typeof row.cls !== 'string' || !row.cls.includes('stop_event')) continue;
        let data: unknown;
        try { data = JSON.parse(row.cls); } catch { continue; }
        if (!data || typeof data !== 'object') continue;
        const card = data as { kind?: unknown; state?: unknown; outcome?: unknown; ts_start?: unknown };
        if (card.kind !== 'stop_event') continue;
        const opened = typeof card.ts_start === 'string' ? Date.parse(card.ts_start) : NaN;
        // Same host clock; the margin only absorbs rounding, not another turn's stop.
        if (!Number.isFinite(opened) || opened < since - 2_000) return undefined;
        const state = typeof card.state === 'string' ? card.state : undefined;
        const outcome = typeof card.outcome === 'string' ? card.outcome : undefined;
        return { confirmed: !!state && STOP_DONE.has(state), ...(state ? { state } : {}), ...(outcome ? { outcome } : {}) };
    }
    return undefined;
}

export type CrewCompaction =
    | { compacted: true; summary: string }
    | { compacted: false; message: string };

/**
 * What a `/compact` turn reported, from the rows after `boundary` (absolute
 * row index). The Gateway tags its notice `meta.kind: "compaction"`
 * (dashboard/chat_utils.py `_append_compaction_notice`): "✅ Conversation
 * compacted[: summary]" on success; failure, timeout and "nothing to compact"
 * notices otherwise. A backend that cannot compact answers an untagged reply.
 */
export function compactionResult(rows: readonly HistoryRow[], offset: number, boundary: number): CrewCompaction {
    const fresh = rows.filter((_, index) => offset + index >= boundary);
    const tagged = [...fresh].reverse().find((row) => row.role === 'assistant' && row.meta?.kind === 'compaction');
    if (tagged) {
        const text = frameText(tagged.content).trim();
        if (text.startsWith('✅')) {
            return { compacted: true, summary: text.replace(/^✅\s*Conversation compacted\.?:?\s*/u, '').trim() };
        }
        return { compacted: false, message: text || 'Kiro Crew did not compact the conversation' };
    }
    const reply = [...fresh].reverse().find((row) => row.role === 'assistant');
    const text = reply ? frameText(reply.content).trim() : '';
    return { compacted: false, message: text || 'Kiro Crew reported no compaction result' };
}

export interface CrewTurnUsage {
    /** kiro-cli's per-turn meteringUsage sum, as the Gateway records it. */
    credits: number;
    turnDurationMs?: number;
}

/**
 * `meta.turn_stats` of the newest assistant row after the last user row
 * (dashboard/chat_turn/turn_stats.py): only what the provider reported, so a
 * turn without credits yields nothing.
 */
export function turnUsage(rows: readonly HistoryRow[]): CrewTurnUsage | undefined {
    let lastUser = -1;
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].role === 'user') { lastUser = i; break; }
    if (lastUser < 0) return undefined;
    for (let i = rows.length - 1; i > lastUser; i--) {
        const row = rows[i];
        const stats = row.role === 'assistant' ? row.meta?.turn_stats : undefined;
        if (!stats || typeof stats !== 'object') continue;
        const { credits, elapsed_ms: elapsed } = stats as { credits?: unknown; elapsed_ms?: unknown };
        if (typeof credits !== 'number' || !Number.isFinite(credits) || credits <= 0) return undefined;
        return { credits, ...(typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed > 0 ? { turnDurationMs: Math.round(elapsed) } : {}) };
    }
    return undefined;
}
