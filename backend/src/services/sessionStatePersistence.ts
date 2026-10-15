import type { AgentSessionState } from 'michi-shared';
import type { AgentSession } from '../agents/types';
import { getDb } from './db';
import { getNode, getWorkspace } from './dbRepository';

/** Persist settings only for the currently bound native chat. Never write a
 * stale worker's state over a replacement session or an Agent Run profile. */
export function persistSessionState(session: AgentSession, ownerUserId: string | null, state: AgentSessionState): void {
    if (session.owner?.kind === 'agent_run' || state.runtimeId !== session.runtimeId) return;
    const node = getNode(session.id);
    if (!node || node.acp_session_id !== session.nativeSessionId || node.runtime_id !== session.runtimeId
        || (node.runtime_engine ?? 'v2') !== (session.nativeEngine ?? 'v2')) return;
    if ((getWorkspace(node.workspace_id)?.owner_user_id ?? null) !== ownerUserId) return;
    const model = state.modelId !== undefined ? state.modelId : node.model_id ?? null;
    const reasoning = state.reasoning !== undefined ? state.reasoning : node.reasoning ?? null;
    const mode = state.currentModeId !== undefined ? state.currentModeId : node.current_mode_id ?? null;
    if (model === node.model_id && reasoning === node.reasoning && mode === node.current_mode_id) return;
    getDb().prepare('UPDATE nodes SET model_id = ?, reasoning = ?, current_mode_id = ? WHERE id = ? AND acp_session_id = ?')
        .run(model, reasoning, mode, session.id, session.nativeSessionId!);
}
