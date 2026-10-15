import { resolve } from 'node:path';

/** A completed, scoped listing is the only evidence that a V3 session is absent.
 * Never turn an incomplete catalog, timeout or authorization error into absence.
 * Michi currently creates local sessions only; remote bindings need an explicit
 * source in the binding before this policy can be expanded.
 */
export async function nativeSessionExists(
    sessionId: string,
    cwd: string,
    list: (params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>,
    timeoutMs = 30_000,
): Promise<boolean> {
    const deadline = Date.now() + Math.min(timeoutMs || 30_000, 30_000);
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Kiro session discovery timed out; original binding retained');
        const result = await list({ cwd, ...(cursor ? { cursor } : {}),
            _meta: { kiro: { scope: 'workspace', source: 'local' } },
        }, remaining) as { sessions?: Array<{ sessionId?: string; cwd?: string; _meta?: { kiro?: { source?: string } } }>; nextCursor?: unknown } | null;
        if (!Array.isArray(result?.sessions)) throw new Error('Kiro returned an incomplete session catalog');
        for (const session of result.sessions) {
            if (typeof session?.sessionId !== 'string' || typeof session.cwd !== 'string') {
                throw new Error('Kiro returned an invalid session catalog entry');
            }
            if (session.sessionId !== sessionId) continue;
            if (resolve(session.cwd) !== resolve(cwd) || (session._meta?.kiro?.source && session._meta.kiro.source !== 'local')) {
                throw new Error('Kiro session belongs to another workspace or source; original binding retained');
            }
            return true;
        }
        if (result.nextCursor == null || result.nextCursor === '') return false;
        if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) {
            throw new Error('Kiro session catalog pagination did not complete');
        }
        cursor = result.nextCursor;
        cursors.add(cursor);
    }
    throw new Error('Kiro session catalog limit reached; original binding retained');
}
