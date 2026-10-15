import { getDb } from '../services/db';

/** Called only after the route authorizes the chat; match the exact node/turn. */
export function chatReplayUnavailable(nodeId: string, turnId: string): { error: string; code: string } {
    const turn = getDb().prepare('SELECT status, error FROM turns WHERE node_id = ? AND turn_id = ?')
        .get(nodeId, turnId) as { status: string; error: string | null } | undefined;
    if (turn?.status === 'error' && turn.error === 'backend_restarted') {
        return {
            error: 'Michi restarted while this task was running. Check the conversation before retrying.',
            code: 'backend_restarted',
        };
    }
    return {
        error: 'The live reply is no longer available. Reopen the conversation to check its saved state before retrying.',
        code: 'turn_replay_unavailable',
    };
}
