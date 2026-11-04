import { extractToolUsePurpose } from "michi-shared";
import type { NormalizedEvent } from "../../services/chatEvents";
import type { SpawnedBranch } from "../toolBridge";
import { PI_TODO_TOOL_NAME, todoPlanFromResult } from "./piTodoTool";
import { parseMcpToolName } from "./mcpToolBridge";

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
 *   host events spawn_branches / artifact_saved / artifact_updated (tool side effects with payload)
 *   plan (the todo tool's list after each change)
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

/**
 * A Pi tool's identity for host policy: every Pi tool is Michi's own
 * (buildPiTools), except a bridged MCP tool, `mcp__<server>__<tool>`.
 */
function toolIdentity(name: unknown): { toolName?: string; mcpServer?: string; hostTool?: boolean } {
    if (typeof name !== "string" || !name) return {};
    const mcp = parseMcpToolName(name);
    return mcp ? { toolName: mcp.toolName, mcpServer: mcp.serverName, hostTool: false } : { toolName: name, hostTool: true };
}

export interface MappedTurnUsage {
    /** Every prompt token the provider processed: fresh input plus cache reads and writes, as for Claude. */
    inputTokens: number;
    /** Of inputTokens, those read from the provider's prompt cache. */
    cachedInputTokens?: number;
    outputTokens: number;
    totalCost: number;
}

/**
 * pi-ai reports cache reads and writes beside `input`, not inside it, so
 * counting `input` alone undercounts every cached request (DeepSeek and
 * Anthropic cache most of a long turn's prompt).
 */
function addUsage(cumulative: MappedTurnUsage, usage: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; cost?: { total?: number } }): void {
    const cacheRead = usage.cacheRead ?? 0;
    cumulative.inputTokens += (usage.input ?? 0) + cacheRead + (usage.cacheWrite ?? 0);
    cumulative.cachedInputTokens = (cumulative.cachedInputTokens ?? 0) + cacheRead;
    cumulative.outputTokens += usage.output ?? 0;
    cumulative.totalCost += usage.cost?.total ?? 0;
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
                addUsage(ctx.cumulative, m.usage);
            }
            if (m?.role === "assistant" && m.stopReason !== "error") ctx.terminalError = undefined;
            if (m?.role === "assistant" && m.stopReason === "error") {
                ctx.terminalError = formatAssistantError(m.errorMessage);
            }
            return;
        }

        case "tool_execution_start": {
            const args = event.args;
            const purpose = extractToolUsePurpose(args);
            yield {
                kind: "tool_call",
                toolCallId: event.toolCallId,
                title: event.toolName,
                detail: purpose,
                status: "pending",
                kindType: "execute",
                inputJson: truncatePayload(args),
                ...toolIdentity(event.toolName),
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
                yield { kind: "host_event", type: "spawn_branches", payload: { topics: created } };
            } else if (name === "save_artifact" && !isError) {
                const d = result?.details;
                if (d?.name && d?.filePath) {
                    yield {
                        kind: "host_event",
                        type: "artifact_saved",
                        payload: {
                            contextId: typeof d.id === "string" ? d.id : undefined,
                            name: d.name,
                            filePath: d.filePath,
                            size: d.size,
                        },
                    };
                }
            } else if (name === "update_artifact" && !isError) {
                const d = result?.details;
                if (d?.name && d?.filePath) {
                    yield {
                        kind: "host_event",
                        type: "artifact_updated",
                        payload: {
                            contextId: typeof d.id === "string" ? d.id : undefined,
                            name: d.name,
                            filePath: d.filePath,
                            size: d.size,
                        },
                    };
                }
            } else if (name === PI_TODO_TOOL_NAME && !isError) {
                // The whole list after the change, like ACP's session/update plan.
                const entries = todoPlanFromResult(result);
                if (entries) yield { kind: "plan", entries };
            }

            yield {
                kind: "tool_call_update",
                toolCallId: event.toolCallId,
                title: name,
                status: isError ? "failed" : "completed",
                detail: isError ? extractErrorText(result) : undefined,
                output: truncatePayload(result),
                ...toolIdentity(name),
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
                inputTokens: ctx.cumulative.inputTokens,
                ...(ctx.cumulative.cachedInputTokens ? { cachedInputTokens: ctx.cumulative.cachedInputTokens } : {}),
                outputTokens: ctx.cumulative.outputTokens,
                totalTokens: ctx.cumulative.inputTokens + ctx.cumulative.outputTokens,
                charge: { amount: ctx.cumulative.totalCost, unit: "USD", provenance: "sdk_estimate" },
                turnDurationMs: Date.now() - ctx.runStartMs,
                source: "estimated",
            };
            if (ctx.terminalError) {
                yield { kind: "runtime_error", error: ctx.terminalError };
                yield { kind: "turn_end", stopReason: "error" };
            } else {
                yield { kind: "turn_end" };
            }
            return;
        }

        case "turn_start":
            yield {
                kind: "harness_lifecycle",
                level: "turn",
                phase: "start",
                nativeType: "turn_start",
            };
            return;

        case "turn_end":
            // Pi turn_end is one LLM call, not the ChatHub done boundary.
            yield {
                kind: "harness_lifecycle",
                level: "turn",
                phase: "completed",
                nativeType: "turn_end",
            };
            return;

        case "tool_execution_update":
            yield {
                kind: "tool_call_update",
                toolCallId: event.toolCallId,
                title: event.toolName ?? "",
                status: "in_progress",
                kindType: "execute",
                output: truncatePayload(event.args ?? event.partialResult ?? event.result),
                ...toolIdentity(event.toolName),
            };
            return;

        case "compaction_start":
        case "session_compaction_start":
            yield { kind: "compaction_start", detail: typeof event.detail === "string" ? event.detail : event.type };
            return;

        case "compaction_end":
        case "session_compaction_end":
            if (event.result?.usage) addUsage(ctx.cumulative, event.result.usage);
            yield { kind: "compaction_end", detail: typeof event.detail === "string" ? event.detail : event.type };
            return;

        case "auto_retry_start":
        case "retry_start":
            yield { kind: "retry_start", detail: typeof event.detail === "string" ? event.detail : event.type };
            return;

        case "auto_retry_end":
        case "retry_end":
            yield { kind: "retry_end", detail: typeof event.detail === "string" ? event.detail : event.type };
            return;

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
