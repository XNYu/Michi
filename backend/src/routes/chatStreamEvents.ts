import type { Response } from "express";
import {
    CHAT_STREAM_EVENTS,
    encodeChatStreamEvent,
    parseSubagentActivityPayload,
    parseSubagentPatches,
} from "michi-shared";
import type { ChatStreamEvent, SubagentPatch } from "michi-shared";
import type { NormalizedEvent } from "../services/chatEvents";
import { decodeMichiHostEvent, type HostEvent, type MichiHostEvent } from "../agents/hostEvents";
import { META_AGENT_GUARD_ERROR_CODE } from 'michi-shared';
import { metaAgentGuardFailureOf } from '../services/metaAgent/guardStatus';

export { CHAT_STREAM_EVENTS };
export type { ChatStreamEvent };

/**
 * Normalize roster patches once, where they enter the stream: the durable
 * projection and every client then fold the same clamped copies (adapters
 * may keep mutating their own objects) with the same timestamps.
 */
function normalizeSubagentPatches(patches: readonly SubagentPatch[]): SubagentPatch[] {
    const now = Date.now();
    return parseSubagentPatches(patches).map((patch) => ({
        ...patch,
        startedAt: patch.startedAt ?? now,
        ...(patch.status === "terminated" && patch.endedAt === undefined ? { endedAt: now } : {}),
    }));
}

function assertNever(value: never): never {
    throw new Error(`Unhandled chat stream event: ${JSON.stringify(value)}`);
}

/** A product event's wire form: its type names the SSE event and its payload is the data. */
function productStreamEvent(event: MichiHostEvent): ChatStreamEvent {
    // MichiHostEvent pairs each type with ChatStreamPayloads[type].
    return { event: event.type, data: event.payload } as ChatStreamEvent;
}

/**
 * The wire event for a runtime event. Only a host event can map to null:
 * one Michi cannot decode is dropped (decodeMichiHostEvent logs it).
 */
export function toChatStreamEvent(ev: Exclude<NormalizedEvent, HostEvent>): ChatStreamEvent;
export function toChatStreamEvent(ev: NormalizedEvent): ChatStreamEvent | null;
export function toChatStreamEvent(ev: NormalizedEvent): ChatStreamEvent | null {
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
                    inputJson: ev.inputJson,
                    output: ev.output,
                },
            };
        case "heartbeat":
            return { event: CHAT_STREAM_EVENTS.heartbeat, data: { idleMs: ev.idleMs } };
        case "title":
            return { event: CHAT_STREAM_EVENTS.title, data: { title: ev.title } };
        case "session_state":
            return { event: CHAT_STREAM_EVENTS.sessionState, data: ev.state };
        case "commands":
            return { event: CHAT_STREAM_EVENTS.commands, data: { commands: ev.commands } };
        case "permission_resolved":
            return { event: CHAT_STREAM_EVENTS.permissionResolved, data: { requestId: ev.requestId } };
        case "permission_request":
            return {
                event: CHAT_STREAM_EVENTS.permissionRequest,
                data: {
                    requestId: ev.requestId,
                    toolCallId: ev.toolCallId,
                    title: ev.title,
                    detail: ev.detail,
                    options: ev.options,
                    ...(ev.source ? { source: ev.source } : {}),
                },
            };
        case "user_input_request":
            return {
                event: CHAT_STREAM_EVENTS.userInputRequest,
                data: { requestId: ev.requestId, ...(ev.interactionId ? { interactionId: ev.interactionId } : {}), questions: ev.questions },
            };
        case "user_input_resolved":
            return {
                event: CHAT_STREAM_EVENTS.userInputResolved,
                data: { requestId: ev.requestId, ...(ev.interactionId ? { interactionId: ev.interactionId } : {}), answers: ev.answers, ...(ev.outcome ? { outcome: ev.outcome } : {}) },
            };
        case "subagent_list_update":
            return { event: CHAT_STREAM_EVENTS.subagentListUpdate, data: { subagents: normalizeSubagentPatches(ev.subagents) } };
        case "subagent_tool_activity": {
            const { kind: _kind, ...activity } = ev;
            return {
                event: CHAT_STREAM_EVENTS.subagentToolActivity,
                data: { ...parseSubagentActivityPayload(activity), at: activity.at ?? Date.now() },
            };
        }
        case "context_usage":
            return { event: CHAT_STREAM_EVENTS.contextUsage, data: { contextUsagePercentage: ev.contextUsagePercentage } };
        case "usage_summary":
            return {
                event: CHAT_STREAM_EVENTS.usageSummary,
                data: {
                    contextUsagePercentage: ev.contextUsagePercentage,
                    totalCredits: ev.totalCredits,
                    ...(ev.charge ? { charge: ev.charge } : {}),
                    turnDurationMs: ev.turnDurationMs,
                    ...(ev.source ? { source: ev.source } : {}),
                    ...(ev.totalTokens !== undefined ? { totalTokens: ev.totalTokens } : {}),
                    ...(ev.inputTokens !== undefined ? { inputTokens: ev.inputTokens } : {}),
                    ...(ev.cachedInputTokens !== undefined ? { cachedInputTokens: ev.cachedInputTokens } : {}),
                    ...(ev.outputTokens !== undefined ? { outputTokens: ev.outputTokens } : {}),
                    ...(ev.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: ev.reasoningOutputTokens } : {}),
                },
            };
        case "cancel_phase":
            return { event: CHAT_STREAM_EVENTS.cancelPhase, data: { phase: ev.phase } };
        case "queue_update":
            return { event: CHAT_STREAM_EVENTS.queueUpdate, data: { steering: ev.steering, followUp: ev.followUp } };
        case "steer_accepted":
            return { event: CHAT_STREAM_EVENTS.steerAccepted, data: { text: ev.text, pending: ev.pending } };
        case "steering_report":
            return { event: CHAT_STREAM_EVENTS.steeringReport, data: { reports: ev.reports, source: 'model', confidence: 'unverified' } };
        case "compaction_start":
            return { event: CHAT_STREAM_EVENTS.compactionStart, data: { detail: ev.detail } };
        case "compaction_end":
            return { event: CHAT_STREAM_EVENTS.compactionEnd, data: { detail: ev.detail } };
        case "retry_start":
            return { event: CHAT_STREAM_EVENTS.retryStart, data: { detail: ev.detail } };
        case "retry_end":
            return { event: CHAT_STREAM_EVENTS.retryEnd, data: { detail: ev.detail } };
        case "harness_lifecycle":
            return {
                event: CHAT_STREAM_EVENTS.harnessLifecycle,
                data: { level: ev.level, phase: ev.phase, nativeType: ev.nativeType },
            };
        case "warning":
            return { event: CHAT_STREAM_EVENTS.warning, data: { source: ev.source, category: ev.category, message: ev.message, code: ev.code, serverName: ev.serverName } };
        case "mcp_server_error":
            return { event: CHAT_STREAM_EVENTS.mcpServerError, data: { serverName: ev.serverName, error: ev.error } };
        case "host_event": {
            const product = decodeMichiHostEvent(ev);
            return product ? productStreamEvent(product) : null;
        }
        case "runtime_error":
            throw withStreamErrorCode(new Error(ev.error), ev.code);
        case "turn_end":
            return { event: CHAT_STREAM_EVENTS.done, data: { stopReason: ev.stopReason } };
        default:
            return assertNever(ev);
    }
}

export function createChatStreamError(message: string, code?: string): ChatStreamEvent {
    return { event: CHAT_STREAM_EVENTS.error, data: { message, ...(code ? { code } : {}) } };
}

/** Carries a runtime_error event's `code` on the error that ends the turn. */
export function withStreamErrorCode<E extends Error>(error: E, code: string | undefined): E {
    return code ? Object.assign(error, { streamErrorCode: code }) : error;
}

/**
 * The `code` of the error frame a failed turn ends with: the Kiro error class
 * the error was tagged with, the code its runtime_error event carried, or
 * META_AGENT_GUARD_ERROR_CODE for a Meta agent restriction check (recognized
 * from its message too, which is all Claude's runtime_error keeps). Other
 * `error.code` values stay off the wire.
 */
export function chatStreamErrorCode(err: unknown): string | undefined {
    const tagged = (typeof err === "object" && err !== null ? err : {}) as { acpErrorKind?: unknown; streamErrorCode?: unknown };
    if (typeof tagged.acpErrorKind === "string" && tagged.acpErrorKind) return tagged.acpErrorKind;
    if (typeof tagged.streamErrorCode === "string" && tagged.streamErrorCode) return tagged.streamErrorCode;
    return metaAgentGuardFailureOf(err) ? META_AGENT_GUARD_ERROR_CODE : undefined;
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
