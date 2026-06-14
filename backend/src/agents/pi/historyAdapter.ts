import type { MessageRow } from "../../services/dbRepository";

/**
 * pi-agent-core's AgentMessage union (only the parts we produce here):
 *   { role: "user", content: TextContent[], timestamp: number }
 *   { role: "assistant", content: TextContent[], api/provider/model/usage/stopReason, timestamp }
 *
 * SQLite stores michi's flattened ChatMessage shape (role + plain text). We
 * cannot recover tool calls / thinking / multi-block content from there —
 * the backend never persisted them in the messages table. Rehydrated
 * sessions therefore have a text-only transcript, which is enough for the
 * model to continue the conversation but loses prior tool-call history.
 *
 * `provider` / `model` are populated with placeholders for assistant rows
 * because pi-agent-core requires those fields to be present. They are not
 * displayed and not used for routing the next call (the live Agent uses
 * agent.state.model for that).
 */
export interface MinimalUserMessage {
    role: "user";
    content: { type: "text"; text: string }[];
    timestamp: number;
}

export interface MinimalAssistantMessage {
    role: "assistant";
    content: { type: "text"; text: string }[];
    api: string;
    provider: string;
    model: string;
    usage: {
        input: 0;
        output: 0;
        cacheRead: 0;
        cacheWrite: 0;
        totalTokens: 0;
        cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0; total: 0 };
    };
    stopReason: "stop";
    timestamp: number;
}

export type MinimalAgentMessage = MinimalUserMessage | MinimalAssistantMessage;

export function rowsToAgentMessages(rows: MessageRow[]): MinimalAgentMessage[] {
    const out: MinimalAgentMessage[] = [];
    for (const row of rows) {
        if (row.role !== "user" && row.role !== "assistant") continue;
        const text = row.content ?? "";
        if (text.length === 0) continue;
        const timestamp = row.created_at;
        if (row.role === "user") {
            out.push({
                role: "user",
                content: [{ type: "text", text }],
                timestamp,
            });
        } else {
            out.push({
                role: "assistant",
                content: [{ type: "text", text }],
                api: "rehydrated",
                provider: "rehydrated",
                model: "rehydrated",
                usage: {
                    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp,
            });
        }
    }
    return out;
}
