import { parseChatStreamEvent, type ChatStreamEvent } from 'michi-shared';
import { getDb } from '../services/db';

/** Called only after the route authorizes the chat; match the exact node/turn. */
export function chatReplayUnavailable(nodeId: string, turnId: string): { error: string; code: string } {
    const turn = getDb().prepare('SELECT status, error FROM turns WHERE node_id = ? AND turn_id = ?')
        .get(nodeId, turnId) as { status: string; error: string | null } | undefined;
    if (turn?.status === 'error' && turn.error === 'backend_restarted') {
        return {
            error: 'Michi restarted while this task was running. Check the conversation before retrying.',
            code: 'backend_restarted',
        };
    }
    if (turn?.status === 'error' && turn.error) {
        return { error: turn.error, code: 'turn_replay_unavailable' };
    }
    return {
        error: 'The live reply is no longer available. Reopen the conversation to check its saved state before retrying.',
        code: 'turn_replay_unavailable',
    };
}

/** Read-only fallback after memory eviction. Caller must authorize the node first.
 * Replay only a contiguous suffix of a durably successful foreground turn. The
 * runtime/session is deliberately irrelevant: it may already have been disposed.
 */
export function persistedChatReplay(nodeId: string, turnId: string, fromSeq: number): ChatStreamEvent[] | null {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) return null;
    const db = getDb();
    const turn = db.prepare(`SELECT status, last_seq, assistant_message_id, stop_reason, completed_at
        FROM turns WHERE node_id = ? AND turn_id = ?`).get(nodeId, turnId) as {
        status: string; last_seq: number; assistant_message_id: string;
        stop_reason: string | null; completed_at: number | null;
    } | undefined;
    if (!turn || !['completed', 'cancelled'].includes(turn.status) || turn.completed_at === null
        || fromSeq > turn.last_seq) return null;
    const start = db.prepare(`SELECT payload FROM harness_events
        WHERE node_id = ? AND turn_id = ? AND seq = 0 AND event = 'turn_start'`)
        .get(nodeId, turnId) as { payload: string } | undefined;
    const first = start && parseChatStreamEvent('turn_start', start.payload);
    if (!first || first.event !== 'turn_start' || first.data.selfInitiated
        || first.data.nodeId !== nodeId || first.data.turnId !== turnId
        || first.data.assistantId !== turn.assistant_message_id) return null;
    const rows = db.prepare(`SELECT seq, event, payload FROM harness_events
        WHERE node_id = ? AND turn_id = ? AND seq >= ? AND seq < ? ORDER BY seq`)
        .all(nodeId, turnId, fromSeq, turn.last_seq) as Array<{ seq: number; event: string; payload: string }>;
    const events: ChatStreamEvent[] = [];
    let expected = fromSeq;
    for (const row of rows) {
        const event = parseChatStreamEvent(row.event, row.payload);
        if (row.seq !== expected++ || !event || event.data.seq !== row.seq
            || event.data.nodeId !== nodeId || event.data.turnId !== turnId
            || event.data.assistantId !== turn.assistant_message_id
            || event.event === 'done' || event.event === 'error') return null;
        events.push(event);
    }
    if (expected !== turn.last_seq) return null;
    // Finalization commits the receipt before journaling/broadcasting done. Use
    // that receipt even if shutdown happened between those two operations.
    events.push({ event: 'done', data: {
        nodeId, chatId: first.data.chatId, turnId, assistantId: turn.assistant_message_id,
        seq: turn.last_seq, persisted: true, completedAt: turn.completed_at, observedAt: turn.completed_at,
        stopReason: turn.status === 'cancelled' ? 'cancelled' : turn.stop_reason ?? 'end_turn',
    } });
    return events;
}
