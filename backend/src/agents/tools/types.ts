/**
 * Shared result shape for in-tree tool implementations.
 *
 * Matches pi-agent-core's AgentToolResult well enough that PiSession's
 * execute closure can return it directly. Kiro path will adapt to its
 * own MCP content shape (which is structurally compatible).
 */

export interface TextContent {
    type: "text";
    text: string;
}

export interface ImageContent {
    type: "image";
    /** base64-encoded bytes (no data: prefix). */
    data: string;
    mimeType: string;
}

export type ToolContent = TextContent | ImageContent;

export interface ToolResult<TDetails = unknown> {
    content: ToolContent[];
    /** Structured payload for the runtime / event mapper (e.g. created branches). */
    details?: TDetails;
    /** Set true when content represents a recoverable error rather than a successful result. */
    isError?: boolean;
}

export function textResult<T = unknown>(text: string, details?: T): ToolResult<T> {
    return { content: [{ type: "text", text }], details };
}

export function errorResult<T = unknown>(message: string): ToolResult<T> {
    return { content: [{ type: "text", text: message }], isError: true };
}
