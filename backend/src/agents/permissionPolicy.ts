/**
 * Permission policy resolver.
 *
 * Strategy "B" (read-default-allow, write/exec-default-ask):
 *   - read / ls / grep / find: allow by default — they cannot mutate state.
 *   - list_threads / search_messages / read_node: allow — read-only db scans.
 *   - spawn_branches / save_artifact / update_artifact: allow — they mutate the chat graph but
 *     are intentional first-class agent moves the user is asking for.
 *   - write / edit / bash: ask by default — destructive or arbitrary.
 *
 * A persisted always-allow grant (workspace_permission_grants) flips an
 * "ask" tool to "allow" for that workspace. There are no persisted denies
 * for now: every "ask" round-trips to the user.
 *
 * Tool-name normalization: the policy categories use the Pi runtime's
 * lowercase builtin names (write/edit/bash). The Claude runtime feeds in
 * Claude's own PascalCase tool names (Bash/Edit/Write/MultiEdit/NotebookEdit)
 * via its permission-prompt-tool, so we map those to the same categories
 * here — otherwise an exact-match set would silently classify every Claude
 * write/exec call as "allow".
 *
 */

import { getRuntimeDeps } from "./runtimeDeps";
import type { BuiltinToolName } from "./builtinTools";

export type PermissionDecision = "allow" | "ask" | "deny";

/** Canonical policy categories that default to "ask". */
const ASK_TOOLS = new Set<string>(["write", "edit", "bash"]);

/** Claude's PascalCase write/exec tools → canonical "ask" categories. */
const CLAUDE_TOOL_ALIASES: Record<string, string> = {
    Bash: "bash",
    Edit: "edit",
    Write: "write",
    MultiEdit: "edit",
    NotebookEdit: "edit",
};

export function canonicalPermissionToolName(toolName: BuiltinToolName | string): string {
    return CLAUDE_TOOL_ALIASES[toolName] ?? toolName;
}

/**
 * Resolve the policy for a tool call. workspaceId may be null for sessions
 * that never bound to a workspace — in that case we still consult defaults
 * but skip the grants lookup.
 */
export function resolvePolicy(
    workspaceId: string | null,
    toolName: BuiltinToolName | string,
    _args: unknown,
): PermissionDecision {
    const canonical = canonicalPermissionToolName(toolName);
    if (!ASK_TOOLS.has(canonical)) return "allow";
    if (workspaceId) {
        const store = getRuntimeDeps().historyStore;
        if (store.hasGrant(workspaceId, canonical) || (canonical !== toolName && store.hasGrant(workspaceId, toolName))) {
            return "allow";
        }
    }
    return "ask";
}
