import type { ChatPermissionMode, PermissionOption } from 'michi-shared';
import type { RuntimeSessionOwner } from './types';
import { getRuntimeDeps } from './runtimeDeps';
import { grantChatPermission, resolveChatPolicy, permissionOwnerUserId, canonicalPermissionToolName } from './permissionPolicy';

export function approvalCoversTool(choice: string | null, approvedTool?: string, pendingTool?: string): boolean {
    return choice === 'allow_session' || (choice === 'allow_always' && !!approvedTool && !!pendingTool
        && canonicalPermissionToolName(approvedTool) === canonicalPermissionToolName(pendingTool));
}

/** Michi keeps grants local; providers receive only single-use approvals. */
export function chatApprovalOptions(toolName?: string): PermissionOption[] {
    return [
        { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
        { optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once' },
        { optionId: 'allow_always', name: 'Trust this tool', kind: 'allow_always', ...(!toolName ? { disabled: true } : {}) },
        { optionId: 'allow_session', name: 'Trust all tools for this session', kind: 'allow_session' },
    ];
}

/** One instance per runtime session. Recreating a session drops its all-tools
 * grant. Explicit permission changes revoke it even during the current turn. */
export class ChatApprovalState {
    private sessionTrust: { nodeId: string; ownerUserId: string | null; resetToken: string | undefined } | undefined;

    private resetToken(owner: RuntimeSessionOwner, ownerUserId?: string | null): string | undefined {
        if (owner.kind !== 'chat_node') return undefined;
        try { return getRuntimeDeps().chatPermissions?.resetToken?.(owner.nodeId, permissionOwnerUserId(owner, ownerUserId)); }
        catch { return undefined; }
    }

    policy(owner: RuntimeSessionOwner, ownerUserId: string | null, toolName: string, nativeRequest: boolean, mode?: ChatPermissionMode) {
        if (this.sessionTrust && (owner.kind !== 'chat_node' || this.sessionTrust.nodeId !== owner.nodeId
            || this.sessionTrust.ownerUserId !== (permissionOwnerUserId(owner, ownerUserId) ?? null)
            || this.sessionTrust.resetToken !== this.resetToken(owner, ownerUserId))) this.sessionTrust = undefined;
        if (owner.kind === 'chat_node' && this.sessionTrust) return 'allow';
        return resolveChatPolicy(owner, ownerUserId, toolName, nativeRequest, mode);
    }

    accept(optionId: string | null, owner: RuntimeSessionOwner, toolName: string | undefined, ownerUserId?: string | null): boolean {
        if (optionId === 'allow_once') return true;
        if (owner.kind !== 'chat_node') return false;
        if (optionId === 'allow_always' && toolName) {
            grantChatPermission(owner, toolName, ownerUserId);
            return true;
        }
        if (optionId === 'allow_session') {
            this.sessionTrust = { nodeId: owner.nodeId, ownerUserId: permissionOwnerUserId(owner, ownerUserId) ?? null,
                resetToken: this.resetToken(owner, ownerUserId) };
            return true;
        }
        return false;
    }
}

/** ACP titles can be prose. Only explicit provider metadata or known exact
 * built-in identifiers can become a reusable tool grant. */
export function acpPermissionToolName(toolCall: any, meta?: any): string | undefined {
    const name = meta?.toolName ?? toolCall?._meta?.toolName;
    if (typeof name === 'string' && name.trim()) return name.trim();
    const title = toolCall?.title;
    return typeof title === 'string' && ACP_BUILTIN_TOOL_NAMES.has(title) ? title : undefined;
}

const ACP_BUILTIN_TOOL_NAMES = new Set([
    'read', 'write', 'edit', 'bash', 'Bash', 'Read', 'Write', 'Edit',
    'fs_read', 'fs_write', 'execute_bash', 'use_aws',
]);
