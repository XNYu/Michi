const SENTINEL_PREFIXES = ["[TITLE:", "[FOLLOW-UP"] as const;

function couldStillBeSentinel(buf: string): boolean {
    const upper = buf.toUpperCase();
    return SENTINEL_PREFIXES.some((p) => (upper.length <= p.length ? p.startsWith(upper) : upper.startsWith(p)));
}

function isCompletedSentinel(buf: string): boolean {
    if (!buf.endsWith("]")) return false;
    const upper = buf.toUpperCase();
    return SENTINEL_PREFIXES.some((p) => upper.startsWith(p));
}

export function stripSentinelsStreamingSafe(raw: string): string {
    type Cut = { start: number; end: number };
    const cuts: Cut[] = [];
    let i = 0;
    let holdStart = -1;
    while (i < raw.length) {
        const ch = raw[i];
        if (holdStart < 0 && ch !== "[") {
            i++;
            continue;
        }
        if (holdStart < 0 && ch === "[") {
            holdStart = i;
            i++;
            continue;
        }
        const buf = raw.slice(holdStart, i + 1);
        if (ch === "]") {
            if (isCompletedSentinel(buf)) {
                let end = i + 1;
                while (end < raw.length && /\s/.test(raw[end])) end++;
                cuts.push({ start: holdStart, end });
                i = end;
            } else {
                i++;
            }
            holdStart = -1;
            continue;
        }
        if (!couldStillBeSentinel(buf)) {
            holdStart = -1;
            i++;
            continue;
        }
        i++;
    }
    if (holdStart >= 0) cuts.push({ start: holdStart, end: raw.length });

    let visible = "";
    let cursor = 0;
    for (const c of cuts) {
        if (c.start > cursor) visible += raw.slice(cursor, c.start);
        cursor = c.end;
    }
    if (cursor < raw.length) visible += raw.slice(cursor);
    return visible;
}

export function normalizeJsonField(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === "string") {
        if (!value.trim()) return null;
        try {
            return JSON.stringify(JSON.parse(value));
        } catch {
            return null;
        }
    }
    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
}

export function deriveAssistantContentFromBlocks(blocks: unknown): string | null {
    let value = blocks;
    if (typeof value === "string" && value.trim()) {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(value)) return null;
    const raw = value
        .map((b) => {
            if (!b || typeof b !== "object") return "";
            const block = b as Record<string, unknown>;
            return block.kind === "answer" && typeof block.rawText === "string" ? block.rawText : "";
        })
        .join("");
    return stripSentinelsStreamingSafe(raw);
}

export function contentFromIncomingMessage(message: Record<string, unknown>): string {
    if (message.role === "assistant") {
        const fromBlocks = deriveAssistantContentFromBlocks(message.blocks);
        if (fromBlocks !== null) return fromBlocks;
    }
    if (typeof message.content === "string") return message.content;
    if (typeof message.text === "string") return message.text;
    return "";
}

export function normalizeIncomingMessageRow(
    raw: Record<string, unknown>,
    fallbackNodeId: string,
    fallbackSeq: number,
): MessageRow {
    const nodeId = typeof raw.node_id === "string" && raw.node_id ? raw.node_id : fallbackNodeId;
    const seq = typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : fallbackSeq;
    return {
        id: typeof raw.id === "string" && raw.id ? raw.id : `${nodeId}-msg-${seq}`,
        node_id: nodeId,
        role: raw.role === "assistant" ? "assistant" : "user",
        content: contentFromIncomingMessage(raw),
        blocks: normalizeJsonField(raw.blocks),
        tool_calls: normalizeJsonField(raw.tool_calls ?? raw.toolCalls),
        seq,
        created_at: typeof raw.created_at === "number"
            ? raw.created_at
            : typeof raw.createdAt === "number"
                ? raw.createdAt
                : Date.now(),
    };
}
import type { MessageRow } from "./dbRepository";
