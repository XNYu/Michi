/** Ordinary chats resolve Ask / Trust / YOLO on the backend for each turn.
 * Native approval requests are gated by mode; Pi also checks tools before
 * execution. Always-allow grants belong to one chat and are revocable.
 */

import { getRuntimeDeps } from "./runtimeDeps";
import type { RuntimeDeps } from './runtimeDeps';
import type { RuntimeSessionOwner } from './types';
import type { ChatPermissionMode } from 'michi-shared';
import { chatNodeOf } from './ownerMapping';

/**
 * The chat node whose modes, grants and reset token apply to an owner;
 * undefined for an Agent Run owner (or none), which has no chat permissions.
 */
export function permissionNodeId(owner: RuntimeSessionOwner | undefined): string | undefined {
    return chatNodeOf(owner);
}

export function chatPermissionMode(owner: RuntimeSessionOwner | undefined, ownerUserId?: string | null): ChatPermissionMode {
    const nodeId = permissionNodeId(owner);
    if (nodeId === undefined) return 'ask';
    const deps = permissionDeps();
    if (!deps?.chatPermissions) return 'ask';
    const userId = permissionOwnerUserId(owner!, ownerUserId);
    return deps.chatPermissions?.getMode(nodeId, userId) ?? 'ask';
}

/** Approve for me is on for this chat's turn: Ask, with the runtime's trust classifier. */
export function chatApproveForMe(owner: RuntimeSessionOwner | undefined, ownerUserId?: string | null): boolean {
    const nodeId = permissionNodeId(owner);
    if (nodeId === undefined) return false;
    const deps = permissionDeps();
    if (!deps?.chatPermissions?.getApproveForMe) return false;
    return deps.chatPermissions.getApproveForMe(nodeId, permissionOwnerUserId(owner!, ownerUserId)) === true;
}

export function permissionOwnerUserId(owner: RuntimeSessionOwner, ownerUserId?: string | null): string | null | undefined {
    const nodeId = permissionNodeId(owner);
    if (ownerUserId || nodeId === undefined) return ownerUserId;
    const deps = permissionDeps();
    const node = deps?.chatPermissions ? deps.historyStore.getNode(nodeId) : null;
    return node?.workspace_id ? deps?.historyStore.getWorkspace(node.workspace_id)?.owner_user_id : null;
}

/** Embedders without the optional chat permission port keep Ask semantics. */
function permissionDeps(): RuntimeDeps | undefined {
    try { return getRuntimeDeps(); } catch { return undefined; }
}

const READ_TOOLS = new Set(['read', 'ls', 'grep', 'find', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    'michi_docs', 'list_threads', 'search_messages', 'read_node', 'read_node_overview', 'read_conversation_updates', 'report_conversation_no_change', 'set_follow_ups',
    'spawn_branches', 'save_artifact', 'update_artifact',
    // Pi's session-local todo list: no file, command, network or workspace effect.
    'todo']);

// The tool enforces its workspace/owner scope and optional requestApproval.
// Do not add a second runtime prompt, including for the known native MCP names.
const THREAD_MESSAGE_TOOLS = new Set(['send_to_thread', 'mcp____michi_internal____send_to_thread', '@michi/send_to_thread']);

// Michi Memory reads and writes (agents/memoryTools.ts) under every runtime's
// name for them: Pi's, Claude's and Codex's MCP name, Kiro's. They reach only
// the user's own memories and the thread's workspace, a write from a turn that
// read untrusted content waits for the user's confirmation, and the user can
// undo a save. memory_delete is not here: it asks like other destructive tools.
const MEMORY_SELF_SCOPED_TOOLS = new Set(['memory_search', 'memory_save', 'memory_update']
    .flatMap((name) => [name, `mcp____michi_internal____${name}`, `@michi/${name}`]));

/** Ordinary chat approvals ignore legacy workspace-wide grants. Apart from
 * scoped thread messaging and Memory reads and writes, native requests ask in
 * Ask mode; Pi also gates unknown/MCP tools before execution. */
export function resolveChatPolicy(owner: RuntimeSessionOwner, ownerUserId: string | null, toolName: string, nativeRequest = false, mode = chatPermissionMode(owner, ownerUserId)): PermissionDecision {
    const nodeId = permissionNodeId(owner);
    if (nodeId !== undefined && (THREAD_MESSAGE_TOOLS.has(toolName) || MEMORY_SELF_SCOPED_TOOLS.has(toolName))) return 'allow';
    if (mode !== 'ask') return 'allow';
    if (nodeId !== undefined && permissionDeps()?.chatPermissions?.hasGrant(nodeId, michiGrantKey(toolName), permissionOwnerUserId(owner, ownerUserId))) return 'allow';
    return !nativeRequest && READ_TOOLS.has(toolName) ? 'allow' : 'ask';
}

export function grantChatPermission(owner: RuntimeSessionOwner, toolName: string, ownerUserId?: string | null): void {
    const nodeId = permissionNodeId(owner);
    if (nodeId !== undefined) permissionDeps()?.chatPermissions?.grant(nodeId, michiGrantKey(toolName), permissionOwnerUserId(owner, ownerUserId));
}

// Moved to the Codex adapter; re-exported for existing importers.
export { codexChatTurnPolicy } from 'michi-runtime/internal/adapters/codex/codexTurnPolicy';

export type PermissionDecision = "allow" | "ask" | "deny";

/**
 * PascalCase write and exec tool names (Claude reports them) and the
 * canonical tool whose grant key they share. Read-only names (Read, Glob,
 * Grep) are not here: their grants were always stored under the name itself.
 */
const GRANT_KEY_ALIASES = new Map([
    ['Bash', 'bash'],
    ['Edit', 'edit'],
    ['Write', 'write'],
    ['MultiEdit', 'edit'],
    ['NotebookEdit', 'edit'],
]);

/**
 * The key a chat always-allow grant is stored under, whichever runtime asks:
 * the name itself, or for the aliases above the canonical tool's, so one
 * grant answers both. Adapters read it through the permission port's
 * grantKey. Saved grants are looked up by this key: never change it.
 */
export function michiGrantKey(toolName: string): string {
    return GRANT_KEY_ALIASES.get(toolName) ?? toolName;
}
