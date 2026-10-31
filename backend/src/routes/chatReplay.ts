import { getDb } from '../services/db';
import { BACKEND_RESTARTED_ERROR, BACKEND_RESTARTED_MESSAGE } from '../services/turnPersistence.recipes';

/** Called only after the route authorizes the chat; match the exact node/turn. */
export function chatReplayUnavailable(nodeId: string, turnId: string): { error: string; code: string } {
    const turn = getDb().prepare('SELECT status, error FROM turns WHERE node_id = ? AND turn_id = ?')
        .get(nodeId, turnId) as { status: string; error: string | null } | undefined;
    if (turn?.status === 'error' && turn.error === BACKEND_RESTARTED_ERROR) {
        return { error: BACKEND_RESTARTED_MESSAGE, code: BACKEND_RESTARTED_ERROR };
    }
    if (turn?.status === 'error' && turn.error) {
        return { error: turn.error, code: 'turn_replay_unavailable' };
    }
    return {
        error: 'The live reply is no longer available. Reopen the conversation to check its saved state before retrying.',
        code: 'turn_replay_unavailable',
    };
}
