/**
 * find — locate files by glob pattern, respecting .gitignore.
 *
 * Walks the directory tree from `path` (or cwd by default), tests each
 * file against `pattern` with minimatch, skips entries matched by any
 * .gitignore in the workspace root.
 *
 * Output format: relative-to-search-root POSIX paths, one per line.
 * Caps at 1000 results OR 150 KB output, whichever fires first.
 *
 * cwd sandbox enforced; `path` arg cannot escape cwd.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import ignoreLib from "ignore";
import { resolveWithinCwd, PathSandboxError } from "./pathSandbox";
import { truncateHead, formatSize, type TruncationDetails } from "./truncate";
import { errorResult, type ToolResult } from "./types";

const DEFAULT_LIMIT = 1000;

const ALWAYS_SKIP = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build"]);

export interface FindArgs {
    pattern: string;
    path?: string;
    limit?: number;
}

export interface FindDetails {
    resultLimitReached?: number;
    truncation?: TruncationDetails;
}

export async function executeFind(args: FindArgs, cwd: string): Promise<ToolResult<FindDetails>> {
    if (!args.pattern || typeof args.pattern !== "string") {
        return errorResult("pattern is required");
    }

    let searchRoot: string;
    try {
        searchRoot = resolveWithinCwd(args.path ?? ".", cwd);
    } catch (e) {
        if (e instanceof PathSandboxError) return errorResult(e.message);
        throw e;
    }

    let stat;
    try {
        stat = await fs.stat(searchRoot);
    } catch {
        return errorResult(`path not found: ${args.path ?? "."}`);
    }
    if (!stat.isDirectory()) return errorResult(`not a directory: ${args.path ?? "."}`);

    const ig = await loadGitignore(cwd);
    const limit = Math.max(1, args.limit ?? DEFAULT_LIMIT);

    const matches: string[] = [];
    let limitReached = false;
    await walk(searchRoot, searchRoot, cwd, ig, async (relFromRoot, _abs) => {
        if (matches.length >= limit) {
            limitReached = true;
            return false;
        }
        if (minimatch(relFromRoot, args.pattern, { dot: true, matchBase: false })) {
            matches.push(relFromRoot);
        }
        return true;
    });

    matches.sort();
    const raw = matches.join("\n");
    const { content, details } = truncateHead(raw);
    const out: FindDetails = {};
    if (limitReached) out.resultLimitReached = limit;
    if (details.truncated) out.truncation = details;

    let text = content || `(no files match "${args.pattern}")`;
    const trailing: string[] = [];
    if (limitReached) trailing.push(`[hit ${limit}-result limit; refine pattern or pass higher limit]`);
    if (details.truncated && details.truncatedBy === "bytes") {
        trailing.push(`[output truncated at ${formatSize(details.outputBytes)}]`);
    }
    if (trailing.length > 0) text = `${text}\n\n${trailing.join("\n")}`;

    return { content: [{ type: "text", text }], details: out };
}

/**
 * Walk a directory tree depth-first. visitor receives the path relative
 * to `root` (POSIX-style for glob matching) plus the absolute path.
 * visitor returns false to abort the walk early.
 */
async function walk(
    dir: string,
    root: string,
    cwd: string,
    ig: ReturnType<typeof ignoreLib> | null,
    visitor: (relFromRoot: string, abs: string) => Promise<boolean>,
): Promise<boolean> {
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return true;
    }
    entries.sort();
    for (const name of entries) {
        if (ALWAYS_SKIP.has(name)) continue;
        const abs = path.join(dir, name);
        const relFromCwd = toPosix(path.relative(cwd, abs));
        if (ig && relFromCwd && ig.ignores(relFromCwd)) continue;
        let entryStat;
        try {
            entryStat = await fs.stat(abs);
        } catch {
            continue;
        }
        const relFromRoot = toPosix(path.relative(root, abs));
        if (entryStat.isDirectory()) {
            const cont = await walk(abs, root, cwd, ig, visitor);
            if (!cont) return false;
        } else if (entryStat.isFile()) {
            const cont = await visitor(relFromRoot, abs);
            if (!cont) return false;
        }
    }
    return true;
}

/**
 * Load and compile a workspace's .gitignore. Returns null when the
 * workspace has no .gitignore (still applies ALWAYS_SKIP).
 */
async function loadGitignore(cwd: string): Promise<ReturnType<typeof ignoreLib> | null> {
    try {
        const raw = await fs.readFile(path.join(cwd, ".gitignore"), "utf-8");
        return ignoreLib().add(raw);
    } catch {
        return null;
    }
}

function toPosix(p: string): string {
    return p.split(path.sep).join("/");
}
