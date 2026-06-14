/**
 * grep — search file contents for a pattern, respecting .gitignore.
 *
 * Walks the directory tree from `path` (or cwd by default), reads each
 * file as UTF-8, scans line by line. Honors .gitignore + a small list
 * of always-skipped directories (.git, node_modules, dist, etc).
 *
 * Output format (per match):
 *   relPath:line:matchedText
 * with optional context lines marked `relPath-line-...`.
 *
 * Caps:
 *   - default 100 matches (configurable via `limit`)
 *   - per-line truncation at GREP_MAX_LINE_LENGTH chars
 *   - whole-output cap via truncateHead (150 KB / 5000 lines)
 *   - skips files larger than 1 MB to avoid choking on lockfiles or
 *     accidental binaries
 *
 * cwd sandbox enforced.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import ignoreLib from "ignore";
import { resolveWithinCwd, PathSandboxError } from "./pathSandbox";
import {
    truncateHead,
    truncateLine,
    formatSize,
    type TruncationDetails,
} from "./truncate";
import { errorResult, type ToolResult } from "./types";

const DEFAULT_LIMIT = 100;
const FILE_SIZE_SKIP = 1024 * 1024;
const ALWAYS_SKIP = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build"]);

export interface GrepArgs {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit?: number;
}

export interface GrepDetails {
    matchLimitReached?: number;
    truncation?: TruncationDetails;
    linesTruncated?: number;
}

export async function executeGrep(args: GrepArgs, cwd: string): Promise<ToolResult<GrepDetails>> {
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

    let regex: RegExp;
    try {
        const source = args.literal ? escapeRegex(args.pattern) : args.pattern;
        regex = new RegExp(source, args.ignoreCase ? "i" : "");
    } catch (e) {
        return errorResult(`invalid regex: ${(e as Error).message}`);
    }

    const ig = await loadGitignore(cwd);
    const limit = Math.max(1, args.limit ?? DEFAULT_LIMIT);
    const ctxLines = Math.max(0, args.context ?? 0);

    const lines: string[] = [];
    let matchesFound = 0;
    let limitReached = false;
    let linesTruncated = 0;

    const isFileTarget = stat.isFile();
    const targets: Array<{ abs: string; relFromRoot: string }> = [];
    if (isFileTarget) {
        targets.push({ abs: searchRoot, relFromRoot: path.basename(searchRoot) });
    } else {
        await walkFiles(searchRoot, searchRoot, cwd, ig, args.glob, (rel, abs) => {
            targets.push({ abs, relFromRoot: rel });
        });
    }

    for (const { abs, relFromRoot } of targets) {
        if (matchesFound >= limit) {
            limitReached = true;
            break;
        }
        let st;
        try {
            st = await fs.stat(abs);
        } catch {
            continue;
        }
        if (st.size > FILE_SIZE_SKIP) continue;

        let content: string;
        try {
            content = (await fs.readFile(abs)).toString("utf-8");
        } catch {
            continue;
        }
        const fileLines = content.split("\n");
        for (let i = 0; i < fileLines.length; i++) {
            if (matchesFound >= limit) {
                limitReached = true;
                break;
            }
            if (!regex.test(fileLines[i])) continue;
            matchesFound++;

            // Context before
            for (let c = Math.max(0, i - ctxLines); c < i; c++) {
                const { text, wasTruncated } = truncateLine(fileLines[c]);
                if (wasTruncated) linesTruncated++;
                lines.push(`${relFromRoot}-${c + 1}-${text}`);
            }
            // Match
            const { text, wasTruncated } = truncateLine(fileLines[i]);
            if (wasTruncated) linesTruncated++;
            lines.push(`${relFromRoot}:${i + 1}:${text}`);
            // Context after
            for (let c = i + 1; c <= i + ctxLines && c < fileLines.length; c++) {
                const { text: ctxText, wasTruncated: ctxTrunc } = truncateLine(fileLines[c]);
                if (ctxTrunc) linesTruncated++;
                lines.push(`${relFromRoot}-${c + 1}-${ctxText}`);
            }
            if (ctxLines > 0) lines.push("--");
        }
    }

    const raw = lines.join("\n");
    const { content, details } = truncateHead(raw);
    const out: GrepDetails = {};
    if (limitReached) out.matchLimitReached = limit;
    if (details.truncated) out.truncation = details;
    if (linesTruncated > 0) out.linesTruncated = linesTruncated;

    let text = content || `(no matches for /${args.pattern}/${args.ignoreCase ? "i" : ""})`;
    const trailing: string[] = [];
    if (limitReached) trailing.push(`[hit ${limit}-match limit; narrow with glob, path, or higher limit]`);
    if (details.truncated && details.truncatedBy === "bytes") {
        trailing.push(`[output truncated at ${formatSize(details.outputBytes)}]`);
    }
    if (linesTruncated > 0) trailing.push(`[${linesTruncated} long line(s) cut at 500 chars]`);
    if (trailing.length > 0) text = `${text}\n\n${trailing.join("\n")}`;

    return { content: [{ type: "text", text }], details: out };
}

async function walkFiles(
    dir: string,
    root: string,
    cwd: string,
    ig: ReturnType<typeof ignoreLib> | null,
    glob: string | undefined,
    visit: (relFromRoot: string, abs: string) => void,
): Promise<void> {
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return;
    }
    entries.sort();
    for (const name of entries) {
        if (ALWAYS_SKIP.has(name)) continue;
        const abs = path.join(dir, name);
        const relFromCwd = toPosix(path.relative(cwd, abs));
        if (ig && relFromCwd && ig.ignores(relFromCwd)) continue;
        let st;
        try {
            st = await fs.stat(abs);
        } catch {
            continue;
        }
        const relFromRoot = toPosix(path.relative(root, abs));
        if (st.isDirectory()) {
            await walkFiles(abs, root, cwd, ig, glob, visit);
        } else if (st.isFile()) {
            if (glob && !minimatch(relFromRoot, glob, { dot: true, matchBase: true })) continue;
            visit(relFromRoot, abs);
        }
    }
}

async function loadGitignore(cwd: string): Promise<ReturnType<typeof ignoreLib> | null> {
    try {
        const raw = await fs.readFile(path.join(cwd, ".gitignore"), "utf-8");
        return ignoreLib().add(raw);
    } catch {
        return null;
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosix(p: string): string {
    return p.split(path.sep).join("/");
}
