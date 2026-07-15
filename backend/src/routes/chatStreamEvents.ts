import type { Response } from "express";
import { CHAT_STREAM_EVENTS, encodeChatStreamEvent } from "michi-shared";
import type { ChatStreamEvent } from "michi-shared";
import type { NormalizedEvent } from "../services/chatEvents";

export { CHAT_STREAM_EVENTS };
export type { ChatStreamEvent };

function assertNever(value: never): never {
    throw new Error(`Unhandled chat stream event: ${JSON.stringify(value)}`);
}

export function toChatStreamEvent(ev: NormalizedEvent): ChatStreamEvent {
    switch (ev.kind) {
        case "chunk":
            return { event: CHAT_STREAM_EVENTS.chunk, data: { text: ev.text } };
        case "thought":
            return { event: CHAT_STREAM_EVENTS.thought, data: { text: ev.text } };
        case "plan":
            return { event: CHAT_STREAM_EVENTS.plan, data: { entries: ev.entries } };
        case "tool_call":
            return {
                event: CHAT_STREAM_EVENTS.toolCall,
                data: {
                    toolCallId: ev.toolCallId,
                    title: ev.title,
                    status: ev.status,
                    kind: ev.kindType,
                    detail: ev.detail,
                    inputJson: ev.inputJson,
                },
            };
        case "tool_call_update":
            return {
                event: CHAT_STREAM_EVENTS.toolCallUpdate,
                data: {
                    toolCallId: ev.toolCallId,
                    title: ev.title,
                    status: ev.status,
                    kind: ev.kindType,
                    detail: ev.detail,
                    output: ev.output,
                },
            };
        case "heartbeat":
            return { event: CHAT_STREAM_EVENTS.heartbeat, data: { idleMs: ev.idleMs } };
        case "spawn_branches":
            return { event: CHAT_STREAM_EVENTS.spawnBranches, data: { topics: ev.topics } };
        case "title":
            return { event: CHAT_STREAM_EVENTS.title, data: { title: ev.title } };
        case "branch_overview":
            return { event: CHAT_STREAM_EVENTS.branchOverview, data: { overview: ev.overview } };
        case "follow_ups":
            return { event: CHAT_STREAM_EVENTS.followUps, data: { followUps: ev.followUps } };
        case "follow_ups_status":
            return { event: CHAT_STREAM_EVENTS.followUpsStatus, data: { status: ev.status } };
        case "commands":
            return { event: CHAT_STREAM_EVENTS.commands, data: { commands: ev.commands } };
        case "context_saved":
            return {
                event: CHAT_STREAM_EVENTS.contextSaved,
                data: { name: ev.name, filePath: ev.filePath, size: ev.size },
            };
        case "context_updated":
            return {
                event: CHAT_STREAM_EVENTS.contextUpdated,
                data: { name: ev.name, filePath: ev.filePath, size: ev.size },
            };
        case "image":
            return {
                event: CHAT_STREAM_EVENTS.image,
                data: { path: ev.path, caption: ev.caption, mimeType: ev.mimeType, size: ev.size },
            };
        case "permission_request":
            return {
                event: CHAT_STREAM_EVENTS.permissionRequest,
                data: {
                    requestId: ev.requestId,
                    toolCallId: ev.toolCallId,
                    title: ev.title,
                    detail: ev.detail,
                    options: ev.options,
                },
            };
        case "subagent_list_update":
            return { event: CHAT_STREAM_EVENTS.subagentListUpdate, data: { subagents: ev.subagents } };
        case "subagent_tool_activity":
            return { event: CHAT_STREAM_EVENTS.subagentToolActivity, data: { subagentSessionId: ev.subagentSessionId, title: ev.title, status: ev.status } };
        case "context_usage":
            return { event: CHAT_STREAM_EVENTS.contextUsage, data: { contextUsagePercentage: ev.contextUsagePercentage } };
        case "usage_summary":
            return { event: CHAT_STREAM_EVENTS.usageSummary, data: { contextUsagePercentage: ev.contextUsagePercentage, totalCredits: ev.totalCredits, turnDurationMs: ev.turnDurationMs } };
        case "mcp_server_error":
            return { event: CHAT_STREAM_EVENTS.mcpServerError, data: { serverName: ev.serverName, error: ev.error } };
        case "turn_end":
            return { event: CHAT_STREAM_EVENTS.done, data: { stopReason: ev.stopReason } };
        default:
            return assertNever(ev);
    }
}

export function createChatStreamError(message: string): ChatStreamEvent {
    return { event: CHAT_STREAM_EVENTS.error, data: { message } };
}

/**
 * The terminal frame the message route must guarantee before `res.end()`.
 *
 * Returns `null` when a terminal frame (`done`/`error`) was already written
 * during the turn. Otherwise returns the frame to write so the client's
 * assistant node can never stay pinned in "streaming": a `done` (cancel) when
 * the turn ended because the client aborted, or an `error` when it ended
 * without any terminal signal (e.g. the event queue closed mid-turn).
 */
export function finalTerminalEvent(opts: {
    wroteTerminal: boolean;
    aborted: boolean;
}): ChatStreamEvent | null {
    if (opts.wroteTerminal) return null;
    if (opts.aborted) {
        return { event: CHAT_STREAM_EVENTS.done, data: { stopReason: "cancel" } };
    }
    return createChatStreamError("stream ended without a terminal event");
}

export function writeChatStreamEvent(
    res: Response,
    streamEvent: ChatStreamEvent,
): void {
    res.write(encodeChatStreamEvent(streamEvent));
}
