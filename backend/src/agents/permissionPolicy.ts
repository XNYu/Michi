/** Ordinary chats resolve Ask / Trust / YOLO on the backend for each turn.
 * Native approval requests are gated by mode; Pi also checks tools before
 * execution. Always-allow grants belong to one chat and are revocable.
 * The legacy workspace resolver remains available to existing embedders.
 */

import { getRuntimeDeps } from "./runtimeDeps";
import type { RuntimeDeps } from './runtimeDeps';
import type { BuiltinToolName } from "./builtinTools";
import type { RuntimeSessionOwner } from './types';
import type { ChatPermissionMode } from 'michi-shared';

export function chatPermissionMode(owner: RuntimeSessionOwner | undefined, ownerUserId?: string | null): ChatPermissionMode {
    if (owner?.kind !== 'chat_node') return 'ask';
    const deps = permissionDeps();
    if (!deps?.chatPermissions) return 'ask';
    const userId = permissionOwnerUserId(owner, ownerUserId);
    return deps.chatPermissions?.getMode(owner.nodeId, userId) ?? 'ask';
}

export function permissionOwnerUserId(owner: RuntimeSessionOwner, ownerUserId?: string | null): string | null | undefined {
    if (ownerUserId || owner.kind !== 'chat_node') return ownerUserId;
    const deps = permissionDeps();
    const node = deps?.chatPermissions ? deps.historyStore.getNode(owner.nodeId) : null;
    return node?.workspace_id ? deps?.historyStore.getWorkspace(node.workspace_id)?.owner_user_id : null;
}

/** Embedders without the optional chat permission port keep Ask semantics. */
function permissionDeps(): RuntimeDeps | undefined {
    try { return getRuntimeDeps(); } catch { return undefined; }
}

const READ_TOOLS = new Set(['read', 'ls', 'grep', 'find', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    'list_threads', 'search_messages', 'read_node', 'read_node_overview', 'set_follow_ups',
    'spawn_branches', 'save_artifact', 'update_artifact']);

/** Ordinary chat approvals ignore legacy workspace-wide grants. Native
 * requests always ask in Ask mode; Pi gates unknown/MCP tools before execution. */
export function resolveChatPolicy(owner: RuntimeSessionOwner, ownerUserId: string | null, toolName: string, nativeRequest = false, mode = chatPermissionMode(owner, ownerUserId)): PermissionDecision {
    if (mode !== 'ask') return 'allow';
    if (owner.kind === 'chat_node' && permissionDeps()?.chatPermissions?.hasGrant(owner.nodeId, canonicalPermissionToolName(toolName), permissionOwnerUserId(owner, ownerUserId))) return 'allow';
    return !nativeRequest && READ_TOOLS.has(toolName) ? 'allow' : 'ask';
}

export function grantChatPermission(owner: RuntimeSessionOwner, toolName: string, ownerUserId?: string | null): void {
    if (owner.kind === 'chat_node') permissionDeps()?.chatPermissions?.grant(owner.nodeId, canonicalPermissionToolName(toolName), permissionOwnerUserId(owner, ownerUserId));
}

export function codexChatTurnPolicy(mode: ChatPermissionMode, cwd: string) {
    if (mode === 'yolo') return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
    if (mode === 'trust') return { approvalPolicy: 'never', sandboxPolicy: {
        type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    } };
    // Unlike on-request, untrusted asks before non-read-only commands without
    // relying on the model to request escalation after a sandbox failure.
    return { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
}

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
