/**
 * write — overwrite a file in the workspace with new contents.
 *
 * Creates the parent directory if missing. cwd sandbox enforced.
 * The user is asked to approve every call (policy "ask"), so this
 * tool deliberately has no soft-guard against overwriting existing
 * files — that's the user's call.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWithinCwd, PathSandboxError } from "./pathSandbox";
import { errorResult, type ToolResult } from "./types";

export interface WriteArgs {
    path: string;
    content: string;
}

export interface WriteDetails {
    filePath: string;
    bytes: number;
    created: boolean;
}

export async function executeWrite(
    args: WriteArgs,
    cwd: string,
    seenPaths?: Set<string>,
): Promise<ToolResult<WriteDetails>> {
    if (typeof args?.path !== "string" || args.path.length === 0) {
        return errorResult("path is required");
    }
    if (typeof args?.content !== "string") {
        return errorResult("content (string) is required");
    }

    let absolutePath: string;
    try {
        absolutePath = resolveWithinCwd(args.path, cwd);
    } catch (e) {
        if (e instanceof PathSandboxError) return errorResult(e.message);
        throw e;
    }

    let created = true;
    try {
        await fs.access(absolutePath);
        created = false;
    } catch {
        // file does not exist — will be created
    }

    // Read-before-overwrite: if the target already exists, the agent must
    // have read it earlier in this session. New files are exempt.
    if (!created && seenPaths && !seenPaths.has(absolutePath)) {
        return errorResult(
            `${args.path} already exists. Read it first with the read tool, then call write again so you don't accidentally clobber content you haven't seen.`,
        );
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, args.content, "utf-8");
    if (seenPaths) seenPaths.add(absolutePath);
    const bytes = Buffer.byteLength(args.content, "utf-8");
    const relPath = path.relative(cwd, absolutePath);

    return {
        content: [
            {
                type: "text",
                text: `${created ? "Created" : "Overwrote"} ${relPath} (${bytes} bytes)`,
            },
        ],
        details: { filePath: relPath, bytes, created },
    };
}
