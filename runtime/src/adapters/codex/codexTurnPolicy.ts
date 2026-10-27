import type { ChatPermissionMode } from 'michi-shared';

/** turn/start approval and sandbox policy of an ordinary chat in each permission mode. */
export function codexChatTurnPolicy(mode: ChatPermissionMode, cwd: string) {
    if (mode === 'yolo') return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
    if (mode === 'trust') return { approvalPolicy: 'never', sandboxPolicy: {
        type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    } };
    // Unlike on-request, untrusted asks before non-read-only commands without
    // relying on the model to request escalation after a sandbox failure.
    return { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
}
