/**
 * read — read a text file or image from the workspace.
 *
 * Text path:
 *   - 1-indexed line offset, optional limit, then truncateHead enforces
 *     the dual line/byte cap (defaults: 5000 lines / 150 KB).
 *   - Truncation footer tells the model how to continue with offset=N.
 *
 * Image path:
 *   - Mime detected by extension (.png/.jpg/.jpeg/.gif/.webp). Files with
 *     other extensions are treated as text.
 *   - 5 MB single-file cap. Per-turn cumulative cap (15 MB default)
 *     enforced via the `quota` argument — caller (PiSession) creates a
 *     fresh quota at the start of each turn.
 *
 * cwd sandbox enforced via resolveWithinCwd.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWithinCwd, PathSandboxError } from "./pathSandbox";
import {
    truncateHead,
    formatSize,
    DEFAULT_MAX_BYTES,
    type TruncationDetails,
} from "./truncate";
import { errorResult, type ToolResult, type ToolContent } from "./types";

export const SINGLE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TURN_IMAGE_QUOTA_BYTES = 15 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};

/** Mutable counter shared across all read calls within a single turn. */
export interface TurnImageQuota {
    usedBytes: number;
    /** Maximum total image bytes allowed across the turn. */
    maxBytes: number;
}

export function makeTurnImageQuota(maxBytes: number = DEFAULT_TURN_IMAGE_QUOTA_BYTES): TurnImageQuota {
    return { usedBytes: 0, maxBytes };
}

export interface ReadArgs {
    path: string;
    /** 1-indexed first line. Default 1. */
    offset?: number;
    /** Max lines to return after offset. */
    limit?: number;
}

export interface ReadDetails {
    truncation?: TruncationDetails;
    image?: {
        mimeType: string;
        bytes: number;
        quotaUsedBytes: number;
        quotaMaxBytes: number;
    };
}

export async function executeRead(
    args: ReadArgs,
    cwd: string,
    quota: TurnImageQuota,
    seenPaths?: Set<string>,
): Promise<ToolResult<ReadDetails>> {
    let absolutePath: string;
    try {
        absolutePath = resolveWithinCwd(args.path, cwd);
    } catch (e) {
        if (e instanceof PathSandboxError) return errorResult(e.message);
        throw e;
    }

    let stat;
    try {
        stat = await fs.stat(absolutePath);
    } catch {
        return errorResult(`file not found: ${args.path}`);
    }
    if (!stat.isFile()) return errorResult(`not a file: ${args.path}`);

    const ext = path.extname(absolutePath).toLowerCase();
    const imageMime = IMAGE_MIME_BY_EXT[ext];
    const result = imageMime
        ? await readImage(absolutePath, args.path, imageMime, stat.size, quota)
        : await readText(absolutePath, args.path, args.offset, args.limit);

    // Record this absolute path so write/edit can require a prior read.
    // Skip on errors so a failed read doesn't unlock a later write.
    if (seenPaths && !result.isError) seenPaths.add(absolutePath);
    return result;
}

async function readText(
    absolutePath: string,
    displayPath: string,
    offset?: number,
    limit?: number,
): Promise<ToolResult<ReadDetails>> {
    const buf = await fs.readFile(absolutePath);
    const text = buf.toString("utf-8");
    const allLines = text.split("\n");
    const totalLines = allLines.length;

    const startLine = offset ? Math.max(0, offset - 1) : 0;
    if (startLine >= totalLines) {
        return errorResult(
            `offset ${offset} is beyond end of file (${totalLines} lines total)`,
        );
    }
    const startDisplay = startLine + 1;

    let selected: string;
    let userLimited: number | undefined;
    if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selected = allLines.slice(startLine, endLine).join("\n");
        userLimited = endLine - startLine;
    } else {
        selected = allLines.slice(startLine).join("\n");
    }

    const { content, details } = truncateHead(selected);
    const out: ReadDetails = { truncation: details.truncated ? details : undefined };

    let outputText: string;
    if (details.firstLineExceedsLimit) {
        const firstLine = allLines[startLine] ?? "";
        outputText =
            `[Line ${startDisplay} is ${formatSize(Buffer.byteLength(firstLine, "utf-8"))}, ` +
            `exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use grep with a narrower pattern, ` +
            `or split the line in your processing.]`;
    } else if (details.truncated) {
        const endDisplay = startDisplay + details.outputLines - 1;
        const nextOffset = endDisplay + 1;
        const reason =
            details.truncatedBy === "lines"
                ? `${details.outputLines}-line window`
                : `${formatSize(details.outputBytes)} / ${formatSize(details.maxBytes)} window`;
        outputText =
            `${content}\n\n[Showing lines ${startDisplay}-${endDisplay} of ${totalLines} ` +
            `(${reason}). If the user asked about the whole document, call read again with offset=${nextOffset} ` +
            `to continue.]`;
    } else if (userLimited !== undefined && startLine + userLimited < totalLines) {
        const remaining = totalLines - (startLine + userLimited);
        const nextOffset = startLine + userLimited + 1;
        outputText = `${content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
    } else {
        outputText = content;
    }

    return {
        content: [{ type: "text", text: outputText }],
        details: out,
    };
}

async function readImage(
    absolutePath: string,
    displayPath: string,
    mimeType: string,
    fileSize: number,
    quota: TurnImageQuota,
): Promise<ToolResult<ReadDetails>> {
    if (fileSize > SINGLE_IMAGE_MAX_BYTES) {
        return errorResult(
            `image ${displayPath} is ${formatSize(fileSize)}, exceeds the ${formatSize(SINGLE_IMAGE_MAX_BYTES)} per-image limit`,
        );
    }
    if (quota.usedBytes + fileSize > quota.maxBytes) {
        return errorResult(
            `image ${displayPath} (${formatSize(fileSize)}) would exceed this turn's image budget ` +
            `(${formatSize(quota.maxBytes)} total, ${formatSize(quota.usedBytes)} used). ` +
            `Read the file content as text or split into a separate turn.`,
        );
    }

    const buf = await fs.readFile(absolutePath);
    quota.usedBytes += buf.byteLength;
    const data = buf.toString("base64");
    const note = `Read image ${displayPath} [${mimeType}, ${formatSize(fileSize)}]`;
    const content: ToolContent[] = [
        { type: "text", text: note },
        { type: "image", data, mimeType },
    ];
    return {
        content,
        details: {
            image: {
                mimeType,
                bytes: fileSize,
                quotaUsedBytes: quota.usedBytes,
                quotaMaxBytes: quota.maxBytes,
            },
        },
    };
}
