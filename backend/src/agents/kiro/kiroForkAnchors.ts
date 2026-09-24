import { getDb } from '../../services/db';
import type { KiroEngine } from './kiroProtocol';

export interface KiroForkAnchor {
    logIndex?: number;
    messageId?: string;
}

export function saveKiroForkAnchor(input: {
    nodeId: string; nativeSessionId: string; engine: KiroEngine;
    assistantMessageId: string; userMessageId?: string;
    anchor: KiroForkAnchor;
}): void {
    // Persist only a server-owned binding. Runtime message IDs never enter the
    // public message metadata or the graph's client-writable sync payload.
    getDb().prepare(`INSERT OR REPLACE INTO kiro_fork_anchors
        (node_id, native_session_id, engine, assistant_message_id, user_message_id, log_index, native_message_id)
        SELECT id, ?, ?, ?, ?, ?, ? FROM nodes WHERE id = ? AND acp_session_id = ?`).run(
        input.nativeSessionId, input.engine, input.assistantMessageId, input.userMessageId ?? null,
        input.anchor.logIndex ?? null, input.anchor.messageId ?? null, input.nodeId, input.nativeSessionId,
    );
}

export function readKiroForkAnchor(nodeId: string, nativeSessionId: string, engine: KiroEngine, messageId: string): KiroForkAnchor | null {
    const row = getDb().prepare(`SELECT log_index, native_message_id FROM kiro_fork_anchors
        WHERE node_id = ? AND native_session_id = ? AND engine = ?
          AND (assistant_message_id = ? OR user_message_id = ?)`).get(
        nodeId, nativeSessionId, engine, messageId, messageId,
    ) as { log_index: number | null; native_message_id: string | null } | undefined;
    if (!row) return null;
    return { ...(row.log_index !== null ? { logIndex: row.log_index } : {}),
        ...(row.native_message_id ? { messageId: row.native_message_id } : {}),
    };
}
