import type { PermissionPolicyPort } from 'michi-runtime';
import {
    ApprovalCoordinator, approvalCoversTool as coordinatorCoversTool, chatApprovalOptions,
} from 'michi-runtime/internal/core/approvals';
import { getRuntimeDeps } from './runtimeDeps';
import {
    grantChatPermission, resolveChatPolicy, permissionOwnerUserId, permissionNodeId, michiGrantKey, chatPermissionMode,
} from './permissionPolicy';

// Michi's side of the package ApprovalCoordinator: its permission policy as
// the host port, and the sessions' ChatApprovalState over it.

/**
 * Michi's chat permission policy (permissionPolicy.ts and the runtime deps'
 * chat permission store) as the runtime host's permission port.
 */
export const michiPermissionPolicy: PermissionPolicyPort = {
    mode: (...args) => chatPermissionMode(...args),
    resolveOwnerUserId: (...args) => permissionOwnerUserId(...args),
    decide: (request) => resolveChatPolicy(request.owner, request.ownerUserId, request.toolName, request.nativeRequest, request.mode),
    grant: (request) => grantChatPermission(request.owner, request.toolName, request.ownerUserId),
    // Only chats have one, and an unconfigured runtime layer has none.
    resetToken: (owner, ownerUserId) => {
        const nodeId = permissionNodeId(owner);
        if (nodeId === undefined) return undefined;
        try { return getRuntimeDeps().chatPermissions?.resetToken?.(nodeId, permissionOwnerUserId(owner, ownerUserId)); }
        catch { return undefined; }
    },
    grantKey: (toolName) => michiGrantKey(toolName),
};

/** Grant keys are Michi's canonical permission tool names. */
export function approvalCoversTool(choice: string | null, approvedTool?: string, pendingTool?: string): boolean {
    return coordinatorCoversTool(choice, approvedTool, pendingTool, michiGrantKey);
}

export { chatApprovalOptions };

/** The ApprovalCoordinator over Michi's permission policy. One instance per
 * runtime session. Recreating a session drops its all-tools grant. Explicit
 * permission changes revoke it even during the current turn. */
export class ChatApprovalState extends ApprovalCoordinator {
    constructor() {
        super({ permissions: michiPermissionPolicy, canonicalize: (toolName) => michiGrantKey(toolName) });
    }
}

// Moved to the Kiro adapter; re-exported for existing callers.
export { acpPermissionToolName } from 'michi-runtime/internal/adapters/kiro/kiroToolNames';
