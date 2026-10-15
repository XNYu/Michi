import { deriveSandboxCwd, normalizeWorkspaceCwd } from '../agents/tools/pathSandbox';
import type { AgentSession, NewAgentSessionOptions } from '../agents/types';
import { getRuntime } from '../agents/registry';
import { getSessionForUser, registerSession, dropSession } from '../agents/sessionRegistry';
import { chatHub } from '../agents/chatHub';
import { getNode, getWorkspace, updateNodeResumeBinding } from './dbRepository';
import { acquireSessionRestoreLock } from './nativeResume';
import { normalizeReasoning } from './resumeStrategy';

/** /clear adopts a fresh context while retaining the visible Michi transcript.
 * Keep the old durable binding until the replacement is ready, so a failed
 * reset can still recover the original session through the usual restore path.
 */
export async function resetKiroContext(original: AgentSession, ownerUserId: string | null,
    bootstrap: Pick<NewAgentSessionOptions, "bootstrapInstructions" | "toolProfile" | "profileHash"> = {}): Promise<AgentSession> {
    const unlock = await acquireSessionRestoreLock(original.id);
    try {
        if (getSessionForUser(original.id, ownerUserId) !== original || chatHub.isActive(original.id)) {
            throw new Error('The session changed or is still running. Retry /clear when it is idle.');
        }
        const node = getNode(original.id);
        const workspace = node ? getWorkspace(node.workspace_id) : null;
        const runtime = getRuntime(original.runtimeId);
        if (!node || !workspace || !runtime || original.runtimeId !== 'kiro' || original.nativeEngine !== 'v3'
            || node.acp_session_id !== original.nativeSessionId || node.runtime_id !== 'kiro' || node.runtime_engine !== 'v3'
            || (runtime.nativeEngine !== undefined && runtime.nativeEngine !== 'v3')
            || original.owner?.kind === 'agent_run' || (workspace.owner_user_id ?? null) !== ownerUserId) {
            throw new Error('Cannot reset this Kiro chat context.');
        }
        if ((original.runtimeProfileHash ?? null) !== (bootstrap.profileHash ?? null)) {
            throw new Error('Cannot reset without the original Agent profile.');
        }
        const state = original.getSessionState?.();
        const model = state?.modelId ?? original.currentModelId ?? node.model_id;
        const mode = state?.currentModeId ?? original.currentModeId;
        const reasoning = state?.reasoning !== undefined ? state.reasoning : normalizeReasoning(node.reasoning);
        // Retire by public ID before creating its replacement: releasing it
        // afterwards could accidentally terminate the new per-chat worker.
        await runtime.releaseSession(original.id);
        dropSession(original.id);
        let replacement: AgentSession | undefined;
        try {
            replacement = await runtime.newSession({ sessionId: original.id, cwd: process.env.MICHI_CLOUD === '1' && ownerUserId ? deriveSandboxCwd(ownerUserId, workspace.id) : normalizeWorkspaceCwd(workspace.cwd ?? process.cwd()),
                workspaceId: workspace.id, ownerUserId, model, reasoning,
                owner: { kind: 'chat_node', nodeId: original.id },
                ...bootstrap,
                ...('getEnableFollowUps' in original && typeof original.getEnableFollowUps === 'function'
                    ? { enableFollowUps: original.getEnableFollowUps() } : {}),
            });
            if (!replacement.nativeSessionId || replacement.nativeSessionId === original.nativeSessionId) {
                throw new Error('Kiro did not create an independent context.');
            }
            replacement.parentChatId = original.parentChatId;
            if (mode && replacement.currentModeId !== mode) await replacement.setMode?.(mode);
            updateNodeResumeBinding(original.id, { acp_session_id: replacement.nativeSessionId,
                runtime_id: 'kiro', runtime_engine: 'v3', provider_id: node.provider_id,
                model_id: replacement.currentModelId ?? model, reasoning,
                current_mode_id: replacement.currentModeId ?? mode,
            });
            registerSession(replacement, ownerUserId);
            return replacement;
        } catch (error) {
            if (replacement) await Promise.resolve(runtime.releaseSession(replacement.id)).catch(() => {});
            dropSession(original.id);
            throw error;
        }
    } finally { unlock(); }
}
