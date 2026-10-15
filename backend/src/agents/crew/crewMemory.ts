import { isCrewMemoryMode, type CrewMemoryMode } from 'michi-shared';
import { getDb } from '../../services/db';

function key(userId?: string | null): string {
    if (process.env.MICHI_CLOUD === '1') {
        if (!userId) throw new Error('Crew preferences require an authenticated owner');
        return `crew_memory:user:${userId}`;
    }
    return 'crew_memory:desktop';
}

export function defaultCrewMemory(userId?: string | null): CrewMemoryMode {
    const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key(userId)) as { value: string } | undefined;
    if (isCrewMemoryMode(row?.value)) return row.value;
    const env = process.env.MICHI_CREW_MEMORY_MODE;
    return isCrewMemoryMode(env) ? env : 'persistent';
}

export function saveDefaultCrewMemory(mode: CrewMemoryMode, userId?: string | null): void {
    if (!isCrewMemoryMode(mode)) throw new Error('Invalid Crew memory mode');
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key(userId), mode);
}

/** Called only after the node's owner has been verified by session setup. */
export function pinCrewMemory(nodeId: string, mode: CrewMemoryMode): void {
    if (!isCrewMemoryMode(mode)) throw new Error('Invalid Crew memory mode');
    getDb().prepare('UPDATE nodes SET crew_memory_mode = ? WHERE id = ? AND (crew_memory_mode IS NULL OR crew_memory_mode != ?)').run(mode, nodeId, mode);
}
