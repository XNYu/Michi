import crypto from "crypto";
import {
    getMessageCount,
    getNode,
    listMessages,
    saveMessage,
    updateNodeBranchOverview,
    updateNodeResumeFingerprint,
    updateNodeTitle,
} from "./dbRepository";
import { stripSentinelsStreamingSafe } from "./messageSerialization";
import { computeTranscriptFingerprint, type TranscriptMessage } from "./resumeStrategy";

/**
 * The frontend creates nodes in its own state and only ships them to SQLite
 * via the bulk /workspaces/:id/sync endpoint. The first turn typically
 * completes before that sync runs, so the node row doesn't exist yet and
 * `messages.node_id` FK insert fails.
 *
 * Both helpers below guard with `getNode(nodeId)` first. If the node isn't
 * persisted yet, skip silently — the next bulk sync will rewrite the full
 * messages array from frontend state, so no data is lost.
 */

export function persistNodeTitle(nodeId: string | undefined, title: string): void {
    if (!nodeId) return;
    if (!getNode(nodeId)) return;
    try {
        updateNodeTitle(nodeId, title);
    } catch (err) {
        console.warn("Failed to persist node title:", err);
    }
}

/** Persist the structured Branches-document block when the local node exists.
 * A newly-created frontend node may not have reached the bulk sync yet; in
 * that case the frontend's normal sync persists the same reducer state later. */
export function persistNodeBranchOverview(nodeId: string | undefined, overview: string): void {
    if (!nodeId || !overview.trim()) return;
    if (!getNode(nodeId)) return;
    try {
        updateNodeBranchOverview(nodeId, overview);
    } catch (err) {
        console.warn("Failed to persist node branch overview:", err);
    }
}

export function persistCompletedTurn(
    nodeId: string | undefined,
    userText: string,
    assistantText: string,
    opts?: { turnId?: string },
): void {
    if (!nodeId || !assistantText) return;
    if (!getNode(nodeId)) return;
    try {
        const seq = getMessageCount(nodeId);
        const now = Date.now();
        const userId = opts?.turnId ? `${opts.turnId}:user` : crypto.randomUUID();
        const assistantId = opts?.turnId ? `${opts.turnId}:assistant` : crypto.randomUUID();
        saveMessage({
            id: userId,
            node_id: nodeId,
            role: "user",
            content: userText,
            tool_calls: null,
            seq,
            created_at: now,
        });
        saveMessage({
            id: assistantId,
            node_id: nodeId,
            role: "assistant",
            content: stripSentinelsStreamingSafe(assistantText),
            blocks: null,
            tool_calls: null,
            seq: seq + 1,
            created_at: now,
        });
        const transcript: TranscriptMessage[] = listMessages(nodeId)
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
                role: m.role === "assistant" ? "assistant" : "user",
                content: m.content,
            }));
        updateNodeResumeFingerprint(nodeId, computeTranscriptFingerprint(transcript));
    } catch (err) {
        console.error("Failed to persist messages:", err);
    }
}
