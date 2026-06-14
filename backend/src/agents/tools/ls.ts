/**
 * ls — list directory contents.
 *
 * Alphabetical (case-insensitive), directories suffixed with "/",
 * dotfiles included. Caps at 500 entries OR 150 KB output, whichever
 * fires first. cwd sandbox enforced.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWithinCwd, PathSandboxError } from "./pathSandbox";
import { truncateHead, formatSize, type TruncationDetails } from "./truncate";
import { errorResult, type ToolResult } from "./types";

const DEFAULT_LIMIT = 500;

export interface LsArgs {
    path?: string;
    limit?: number;
}

export interface LsDetails {
    entryLimitReached?: number;
    truncation?: TruncationDetails;
}

export async function executeLs(args: LsArgs, cwd: string): Promise<ToolResult<LsDetails>> {
    let absolutePath: string;
    try {
        absolutePath = resolveWithinCwd(args.path ?? ".", cwd);
    } catch (e) {
        if (e instanceof PathSandboxError) return errorResult(e.message);
        throw e;
    }

    let stat;
    try {
        stat = await fs.stat(absolutePath);
    } catch {
        return errorResult(`path not found: ${args.path ?? "."}`);
    }
    if (!stat.isDirectory()) return errorResult(`not a directory: ${args.path ?? "."}`);

    let entries: string[];
    try {
        entries = await fs.readdir(absolutePath);
    } catch (e) {
        return errorResult(`cannot read directory: ${(e as Error).message}`);
    }

    entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    const effectiveLimit = Math.max(1, args.limit ?? DEFAULT_LIMIT);
    const lines: string[] = [];
    let entryLimitReached: number | undefined;
    for (const name of entries) {
        if (lines.length >= effectiveLimit) {
            entryLimitReached = effectiveLimit;
            break;
        }
        let isDir = false;
        try {
            isDir = (await fs.stat(path.join(absolutePath, name))).isDirectory();
        } catch {
            // unreadable entry — list its name without suffix
        }
        lines.push(isDir ? `${name}/` : name);
    }

    const raw = lines.join("\n");
    const { content, details } = truncateHead(raw);
    const result: LsDetails = {};
    if (entryLimitReached) result.entryLimitReached = entryLimitReached;
    if (details.truncated) result.truncation = details;

    let text = content;
    const trailing: string[] = [];
    if (entryLimitReached) trailing.push(`[${entries.length - effectiveLimit} more entries omitted (limit ${effectiveLimit})]`);
    if (details.truncated && details.truncatedBy === "bytes") {
        trailing.push(`[output truncated at ${formatSize(details.outputBytes)}]`);
    }
    if (trailing.length > 0) text = `${text}\n\n${trailing.join("\n")}`;

    return { content: [{ type: "text", text }], details: result };
}
