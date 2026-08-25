import type { NormalizedEvent } from "../../services/chatEvents";
import type { SpawnedBranch } from "../toolBridge";

/**
 * Translate a single pi-agent-core AgentEvent into 0+ michi NormalizedEvents.
 *
 * pi-agent-core emits:
 *   agent_start → agent_end (run-level)
 *   turn_start → turn_end (one LLM call + its tool batch)
 *   message_start / message_update / message_end (any message)
 *   tool_execution_start / tool_execution_update / tool_execution_end
 *
 * michi expects:
 *   chunk / thought (assistant text/reasoning streamed)
 *   tool_call / tool_call_update (chips for tool calls)
 *   spawn_branches / artifact_saved / artifact_updated (tool side effects with payload)
 *   context_usage / usage_summary (one-shot at run end)
 *   turn_end (closes SSE)
 *
 * Title and follow-ups are emitted as inline `[TITLE:]` / `[FOLLOW-UP n/3:]`
 * sentinels in the assistant's text stream and parsed by the frontend; they
 * do NOT come through tool calls. This mapper only cares about the two
 * side-effect tools (spawn_branches, save_artifact, update_artifact).
 */
const MAX_TOOL_PAYLOAD = 16 * 1024;

function truncatePayload(value: unknown): string | undefined {
    if (value == null) return undefined;
    const str = typeof value === "string" ? value : JSON.stringify(value);
    if (!str) return undefined;
    return str.length > MAX_TOOL_PAYLOAD ? str.slice(0, MAX_TOOL_PAYLOAD) : str;
}

export interface MappedTurnUsage {
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
}

export interface MapperContext {
    /** Mutated as turns accumulate within one Agent run. */
    cumulative: MappedTurnUsage;
    /** Provided by the caller; used for the run-end context_usage event. */
    contextWindow?: number;
    /** Wall-clock ms of when prompt() began. Set by the caller. */
    runStartMs: number;
    /** Provider error captured from the terminal assistant message. */
    terminalError?: string;
}

export function* mapAgentEvent(event: any, ctx: MapperContext): Iterable<NormalizedEvent> {
    switch (event.type) {
        case "message_update": {
            // Only assistant message updates carry deltas.
            const e = event.assistantMessageEvent;
            if (!e) return;
            if (e.type === "text_delta") {
                yield { kind: "chunk", text: e.delta };
            } else if (e.type === "thinking_delta") {
                yield { kind: "thought", text: e.delta };
            }
            return;
        }

        case "message_end": {
            const m = event.message;
            if (m?.role === "assistant" && m.usage) {
                ctx.cumulative.inputTokens += m.usage.input ?? 0;
                ctx.cumulative.outputTokens += m.usage.output ?? 0;
                ctx.cumulative.totalCost += m.usage.cost?.total ?? 0;
            }
            if (m?.role === "assistant" && m.stopReason === "error") {
                ctx.terminalError = formatAssistantError(m.errorMessage);
            }
            return;
        }

        case "tool_execution_start": {
            const args = event.args;
            const purpose = typeof args?.__tool_use_purpose === "string"
                ? args.__tool_use_purpose
                : typeof args?.description === "string"
                    ? args.description
                    : undefined;
            yield {
                kind: "tool_call",
                toolCallId: event.toolCallId,
                title: event.toolName,
                detail: purpose,
                status: "pending",
                kindType: "execute",
                inputJson: truncatePayload(args),
            };
            return;
        }

        case "tool_execution_end": {
            const name: string = event.toolName;
            const result = event.result;
            const isError: boolean = !!event.isError;

            // Side-effect events that carry tool payload.
            if (name === "spawn_branches" && !isError) {
                const created: SpawnedBranch[] = result?.details?.created ?? [];
                yield { kind: "spawn_branches", topics: created };
            } else if (name === "save_artifact" && !isError) {
                const d = result?.details;
                if (d?.name && d?.filePath) {
                    yield {
                        kind: "artifact_saved",
                        contextId: typeof d.id === "string" ? d.id : undefined,
                        name: d.name,
                        filePath: d.filePath,
                        size: d.size,
                    };
                }
            } else if (name === "update_artifact" && !isError) {
                const d = result?.details;
                if (d?.name && d?.filePath) {
                    yield {
                        kind: "artifact_updated",
                        contextId: typeof d.id === "string" ? d.id : undefined,
                        name: d.name,
                        filePath: d.filePath,
                        size: d.size,
                    };
                }
            }

            yield {
                kind: "tool_call_update",
                toolCallId: event.toolCallId,
                title: name,
                status: isError ? "failed" : "completed",
                detail: isError ? extractErrorText(result) : undefined,
                output: truncatePayload(result),
            };
            return;
        }

        case "agent_end": {
            // One-shot end-of-run summary, then the SSE-closing turn_end.
            const ctxPct = ctx.contextWindow
                ? ((ctx.cumulative.inputTokens + ctx.cumulative.outputTokens) / ctx.contextWindow) * 100
                : 0;
            yield { kind: "context_usage", contextUsagePercentage: ctxPct };
            yield {
                kind: "usage_summary",
                contextUsagePercentage: ctxPct,
                totalCredits: ctx.cumulative.totalCost,
                turnDurationMs: Date.now() - ctx.runStartMs,
            };
            if (ctx.terminalError) {
                yield { kind: "runtime_error", error: ctx.terminalError };
                yield { kind: "turn_end", stopReason: "error" };
            } else {
                yield { kind: "turn_end" };
            }
            return;
        }

        // agent_start / turn_start / turn_end / message_start / tool_execution_update:
        // intentionally not surfaced — michi has no SSE event for these and they
        // would just be noise on the wire.
        default:
            return;
    }
}

function formatAssistantError(value: unknown): string {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "The model failed without returning an error message.";

    const jsonStart = raw.indexOf("{");
    if (jsonStart < 0) return raw;

    try {
        const parsed = JSON.parse(raw.slice(jsonStart)) as Record<string, any>;
        const body = parsed.error && typeof parsed.error === "object"
            ? parsed.error
            : parsed;
        const detail = typeof body.metadata?.raw === "string"
            ? body.metadata.raw.trim()
            : typeof body.message === "string"
                ? body.message.trim()
                : raw;
        const remedy = typeof body.metadata?.remedy_hint === "string"
            ? body.metadata.remedy_hint.trim()
            : "";
        const prefixCode = raw.slice(0, jsonStart).match(/\b\d{3}\b/)?.[0];
        const code = body.code != null ? String(body.code) : prefixCode;
        const headline = code && !detail.startsWith(`${code}:`)
            ? `${code}: ${detail}`
            : detail;
        return remedy && remedy !== detail
            ? `${headline}\n${remedy}`
            : headline;
    } catch {
        return raw;
    }
}

function extractErrorText(result: any): string | undefined {
    if (!result) return undefined;
    const c = result.content;
    if (Array.isArray(c) && c.length > 0 && c[0]?.type === "text") return c[0].text;
    return undefined;
}
