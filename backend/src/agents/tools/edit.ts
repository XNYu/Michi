/**
 * edit — string-replace edit on an existing file.
 *
 * old_string MUST occur EXACTLY ONCE in the file. Multiple matches
 * (or zero matches) are an error — the model is expected to widen
 * the context (more surrounding lines) until uniqueness holds, the
 * same contract Claude Code's Edit tool uses.
 *
 * No mutation queue: Pi sessions execute one tool at a time.
 *
 * The user is asked to approve every call (policy "ask").
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWithinCwd, PathSandboxError } from "./pathSandbox";
import { errorResult, type ToolResult } from "./types";

export interface EditArgs {
    path: string;
    old_string: string;
    new_string: string;
}

export interface EditDetails {
    filePath: string;
    oldBytes: number;
    newBytes: number;
}

export async function executeEdit(
    args: EditArgs,
    cwd: string,
    seenPaths?: Set<string>,
): Promise<ToolResult<EditDetails>> {
    if (typeof args?.path !== "string" || args.path.length === 0) {
        return errorResult("path is required");
    }
    if (typeof args?.old_string !== "string" || args.old_string.length === 0) {
        return errorResult("old_string is required and must be non-empty");
    }
    if (typeof args?.new_string !== "string") {
        return errorResult("new_string is required");
    }
    if (args.old_string === args.new_string) {
        return errorResult("old_string and new_string are identical — nothing to edit");
    }

    let absolutePath: string;
    try {
        absolutePath = resolveWithinCwd(args.path, cwd);
    } catch (e) {
        if (e instanceof PathSandboxError) return errorResult(e.message);
        throw e;
    }

    // Edit ALWAYS requires a prior read — there's no "new file" case.
    if (seenPaths && !seenPaths.has(absolutePath)) {
        return errorResult(
            `Read ${args.path} first with the read tool before editing it. Edits target text you've actually seen.`,
        );
    }

    let original: string;
    try {
        original = (await fs.readFile(absolutePath)).toString("utf-8");
    } catch {
        return errorResult(`file not found: ${args.path}`);
    }

    const firstIdx = original.indexOf(args.old_string);
    if (firstIdx === -1) {
        return errorResult(
            `old_string not found in ${args.path}. Widen the context (include more surrounding lines) and retry.`,
        );
    }
    const secondIdx = original.indexOf(args.old_string, firstIdx + args.old_string.length);
    if (secondIdx !== -1) {
        return errorResult(
            `old_string is not unique in ${args.path}. Widen the context until exactly one match remains.`,
        );
    }

    const updated =
        original.slice(0, firstIdx) + args.new_string + original.slice(firstIdx + args.old_string.length);
    await fs.writeFile(absolutePath, updated, "utf-8");

    const oldBytes = Buffer.byteLength(args.old_string, "utf-8");
    const newBytes = Buffer.byteLength(args.new_string, "utf-8");
    const relPath = path.relative(cwd, absolutePath);
    const delta = newBytes - oldBytes;
    const sign = delta >= 0 ? "+" : "−";

    return {
        content: [
            {
                type: "text",
                text: `Edited ${relPath} (${sign}${Math.abs(delta)} bytes)`,
            },
        ],
        details: { filePath: relPath, oldBytes, newBytes },
    };
}
