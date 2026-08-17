/**
 * Shared ACP tool-call / permission translation.
 *
 * Cursor (and some other ACP agents) emit empty tool_call events
 * (`title: "MCP: tool"`, `rawInput: {}`, `rawOutput: { success: true }`)
 * and put the real name / args on session/request_permission.toolCall.
 * Grok is richer (title, rawInput.tool_name, content[], rawOutput).
 * Kiro already sends real titles on tool_call.
 *
 * This helper prefers the richest available fields without inventing data.
 */

const USELESS_TITLES = new Set([
    "mcp: tool",
    "tool",
    "use_tool",
    "search_tool",
]);

export interface TranslatedToolCall {
    toolCallId: string;
    title: string;
    status: string;
    kindType?: string;
    detail?: string;
    inputJson?: string;
    output?: string;
}

export function isUselessToolTitle(title: string): boolean {
    return USELESS_TITLES.has(title.trim().toLowerCase());
}

export function isEmptyRawInput(rawInput: unknown): boolean {
    if (rawInput == null) return true;
    if (typeof rawInput === "string") {
        const trimmed = rawInput.trim();
        return trimmed === "" || trimmed === "{}";
    }
    if (typeof rawInput !== "object") return false;
    if (Array.isArray(rawInput)) return rawInput.length === 0;
    return Object.keys(rawInput as object).length === 0;
}

/** `{success:true}`, `{}`, null, or the equivalent JSON string — not a real result. */
export function isPlaceholderToolOutput(rawOutput: unknown): boolean {
    if (rawOutput == null) return true;
    if (typeof rawOutput === "string") {
        const trimmed = rawOutput.trim();
        if (!trimmed || trimmed === "{}" || trimmed === "[]") return true;
        try {
            return isPlaceholderToolOutput(JSON.parse(trimmed));
        } catch {
            return false;
        }
    }
    if (typeof rawOutput !== "object" || Array.isArray(rawOutput)) return false;
    const keys = Object.keys(rawOutput);
    if (keys.length === 0) return true;
    const rec = rawOutput as Record<string, unknown>;
    return keys.length === 1 && keys[0] === "success" && rec.success === true;
}

/** Walk ACP / MCP content blocks, including Cursor's `{type:"content", content:{type:"text"}}`. */
export function extractAcpContentText(content: unknown): string {
    const blocks = Array.isArray(content) ? content : content ? [content] : [];
    const parts: string[] = [];
    for (const block of blocks) {
        const text = contentBlockText(block);
        if (text) parts.push(text);
    }
    return parts.join("");
}

function contentBlockText(block: unknown): string {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return "";
    const rec = block as Record<string, unknown>;
    if (typeof rec.text === "string" && rec.text) return rec.text;
    if (rec.content !== undefined) return extractAcpContentText(rec.content);
    return "";
}

export function stripJsonFence(text: string): string {
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
    return fenced ? fenced[1].trim() : trimmed;
}

function betterToolName(update: Record<string, any>): string {
    const raw = update.rawInput;
    if (raw && typeof raw === "object") {
        if (typeof raw.tool_name === "string" && raw.tool_name.trim()) {
            return raw.tool_name.trim();
        }
        const fromRawMeta = xaiToolName(raw._meta);
        if (fromRawMeta) return fromRawMeta;
    }
    return xaiToolName(update._meta);
}

function xaiToolName(meta: unknown): string {
    if (!meta || typeof meta !== "object") return "";
    const tool = (meta as Record<string, any>)["x.ai/tool"];
    if (tool && typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
    return "";
}

export function resolveToolTitle(update: Record<string, any>): string {
    const title = typeof update.title === "string" ? update.title.trim() : "";
    const better = betterToolName(update);
    if (title && !isUselessToolTitle(title)) return title;
    if (better) return better;
    return "";
}

export function resolveToolInputJson(update: Record<string, any>): string | undefined {
    const raw = update.rawInput;
    if (!isEmptyRawInput(raw)) {
        return typeof raw === "string" ? raw : JSON.stringify(raw);
    }
    const text = extractAcpContentText(update.content);
    if (!text) return undefined;
    return stripJsonFence(text);
}

export function resolveToolOutput(update: Record<string, any>): string | undefined {
    const raw = update.rawOutput;
    if (!isPlaceholderToolOutput(raw)) {
        return typeof raw === "string" ? raw : JSON.stringify(raw);
    }
    const text = extractAcpContentText(update.content);
    return text || undefined;
}

function resolveToolDetail(update: Record<string, any>, title: string): string | undefined {
    const raw = update.rawInput;
    if (!raw || typeof raw !== "object") return undefined;
    if (typeof raw.__tool_use_purpose === "string") return raw.__tool_use_purpose;
    if (typeof raw.description === "string") return raw.description;
    if (typeof raw.file_path === "string") {
        return title ? `${title}: ${raw.file_path}` : raw.file_path;
    }
    return undefined;
}

export function translateAcpToolCall(update: Record<string, any> | null | undefined): TranslatedToolCall {
    const src = update && typeof update === "object" ? update : {};
    const title = resolveToolTitle(src);
    const toolCallId = typeof src.toolCallId === "string" ? src.toolCallId : "";
    const status = typeof src.status === "string" ? src.status : "";
    const kindType = typeof src.kind === "string" && src.kind ? src.kind : undefined;
    return {
        toolCallId,
        title,
        status,
        kindType,
        detail: resolveToolDetail(src, title),
        inputJson: resolveToolInputJson(src),
        output: resolveToolOutput(src),
    };
}

/** Prefer the MCP text payload (what the model sees) over the envelope JSON. */
export function formatMcpToolOutput(result: unknown): string {
    if (result && typeof result === "object") {
        const text = extractAcpContentText((result as { content?: unknown }).content);
        if (text) return text;
    }
    if (typeof result === "string") return result;
    try {
        return JSON.stringify(result ?? {});
    } catch {
        return String(result);
    }
}
