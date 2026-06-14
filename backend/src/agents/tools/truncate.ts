/**
 * Output truncation utilities shared by file/text-producing tools.
 *
 * Truncation enforces TWO independent limits — whichever is hit first wins:
 *   - line limit (default 5000)
 *   - byte limit (default 150 KB)
 *
 * Never returns partial lines from `truncateHead` (file reads); `truncateTail`
 * may keep a partial first line so a single very long bash line still
 * shows its tail.
 *
 * Defaults are tuned for rabbitholes' workspace use case (markdown notes,
 * research logs) — bigger than pi-coding-agent's 50 KB / 2000 lines because
 * single-document reads here are typically the WHOLE artifact, not a code file
 * the model is going to read in chunks.
 */

export const DEFAULT_MAX_LINES = 5000;
export const DEFAULT_MAX_BYTES = 150 * 1024;
export const GREP_MAX_LINE_LENGTH = 500;

export interface TruncationDetails {
    truncated: boolean;
    /** Which limit was hit, or null when no truncation happened. */
    truncatedBy: "lines" | "bytes" | null;
    totalLines: number;
    totalBytes: number;
    outputLines: number;
    outputBytes: number;
    /** True when the *first* line alone exceeded maxBytes (head only). */
    firstLineExceedsLimit: boolean;
    /** True when the kept output contains a partial line (tail only). */
    lastLinePartial: boolean;
    maxLines: number;
    maxBytes: number;
}

export interface TruncateResult {
    content: string;
    details: TruncationDetails;
}

export interface TruncateOptions {
    maxLines?: number;
    maxBytes?: number;
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Keep the first N lines/bytes. Use for file reads — the start of a doc
 * is usually the most relevant part (titles, imports, abstracts).
 *
 * Never returns a partial line. If the very first line already exceeds
 * maxBytes, returns empty content with firstLineExceedsLimit=true so the
 * caller can suggest a byte-bounded fallback.
 */
export function truncateHead(content: string, options: TruncateOptions = {}): TruncateResult {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const totalBytes = Buffer.byteLength(content, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return {
            content,
            details: {
                truncated: false,
                truncatedBy: null,
                totalLines,
                totalBytes,
                outputLines: totalLines,
                outputBytes: totalBytes,
                firstLineExceedsLimit: false,
                lastLinePartial: false,
                maxLines,
                maxBytes,
            },
        };
    }

    const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
    if (firstLineBytes > maxBytes) {
        return {
            content: "",
            details: {
                truncated: true,
                truncatedBy: "bytes",
                totalLines,
                totalBytes,
                outputLines: 0,
                outputBytes: 0,
                firstLineExceedsLimit: true,
                lastLinePartial: false,
                maxLines,
                maxBytes,
            },
        };
    }

    const kept: string[] = [];
    let bytesUsed = 0;
    let truncatedBy: "lines" | "bytes" = "lines";
    for (let i = 0; i < lines.length && i < maxLines; i++) {
        const line = lines[i];
        const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);
        if (bytesUsed + lineBytes > maxBytes) {
            truncatedBy = "bytes";
            break;
        }
        kept.push(line);
        bytesUsed += lineBytes;
    }
    if (kept.length >= maxLines && bytesUsed <= maxBytes) truncatedBy = "lines";

    const outContent = kept.join("\n");
    return {
        content: outContent,
        details: {
            truncated: true,
            truncatedBy,
            totalLines,
            totalBytes,
            outputLines: kept.length,
            outputBytes: Buffer.byteLength(outContent, "utf-8"),
            firstLineExceedsLimit: false,
            lastLinePartial: false,
            maxLines,
            maxBytes,
        },
    };
}

/**
 * Keep the last N lines/bytes. Use for command output where the tail
 * carries the meaningful payload (errors, exit codes, final logs).
 *
 * If even the last line alone exceeds maxBytes, slices that line at a
 * UTF-8 boundary and sets lastLinePartial=true.
 */
export function truncateTail(content: string, options: TruncateOptions = {}): TruncateResult {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const totalBytes = Buffer.byteLength(content, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return {
            content,
            details: {
                truncated: false,
                truncatedBy: null,
                totalLines,
                totalBytes,
                outputLines: totalLines,
                outputBytes: totalBytes,
                firstLineExceedsLimit: false,
                lastLinePartial: false,
                maxLines,
                maxBytes,
            },
        };
    }

    const kept: string[] = [];
    let bytesUsed = 0;
    let truncatedBy: "lines" | "bytes" = "lines";
    let partial = false;

    for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
        const line = lines[i];
        const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
        if (bytesUsed + lineBytes > maxBytes) {
            truncatedBy = "bytes";
            // First-iter edge case: even one full line doesn't fit. Keep its tail at a UTF-8 boundary.
            if (kept.length === 0) {
                const sliced = sliceFromEndAtUtf8Boundary(line, maxBytes);
                kept.unshift(sliced);
                bytesUsed = Buffer.byteLength(sliced, "utf-8");
                partial = true;
            }
            break;
        }
        kept.unshift(line);
        bytesUsed += lineBytes;
    }
    if (kept.length >= maxLines && bytesUsed <= maxBytes) truncatedBy = "lines";

    const outContent = kept.join("\n");
    return {
        content: outContent,
        details: {
            truncated: true,
            truncatedBy,
            totalLines,
            totalBytes,
            outputLines: kept.length,
            outputBytes: Buffer.byteLength(outContent, "utf-8"),
            firstLineExceedsLimit: false,
            lastLinePartial: partial,
            maxLines,
            maxBytes,
        },
    };
}

/**
 * Cap a single line at maxChars (character count, not bytes — grep matches
 * are user-readable and CJK-safe at the char level). Suffixes "... [truncated]"
 * when cut. Used per-match to keep grep output scannable when one line
 * happens to be a minified blob.
 */
export function truncateLine(line: string, maxChars: number = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } {
    if (line.length <= maxChars) return { text: line, wasTruncated: false };
    return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

/**
 * Slice a string from its end so the result fits within maxBytes (UTF-8).
 * Walks forward over any continuation bytes (0b10xxxxxx) so the cut
 * lands on a character boundary instead of producing mojibake.
 */
function sliceFromEndAtUtf8Boundary(str: string, maxBytes: number): string {
    const buf = Buffer.from(str, "utf-8");
    if (buf.length <= maxBytes) return str;
    let start = buf.length - maxBytes;
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
    return buf.subarray(start).toString("utf-8");
}
