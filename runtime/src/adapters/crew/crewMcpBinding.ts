import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const crewMcpDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
    env.MICHI_CREW_MCP_DIR || path.join(os.homedir(), '.michi', 'crew-mcp');

function bindingPath(directory: string, session: string): string {
    return path.join(directory, `${createHash('sha256').update(session).digest('hex')}.json`);
}

export function validateMichiEndpoint(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Missing Michi MCP endpoint');
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
        || url.username || url.password || url.search || url.hash
        || !/^\/api\/mcp\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
        throw new Error('Invalid Michi MCP endpoint');
    }
    return url.href;
}

/** A process owns only the bindings it wrote; an older adapter cannot unlink a resume. */
export class CrewMcpBindings {
    private readonly owner = randomUUID();
    private readonly sessions = new Map<string, string>();
    constructor(private readonly directory = crewMcpDirectory()) {}

    async bind(slot: string, servers: unknown[]): Promise<() => Promise<void>> {
        const server = servers.find((item) => !!item && typeof item === 'object'
            && (item as { name?: string }).name === 'michi') as { url?: unknown; headers?: unknown[] } | undefined;
        if (!server) return async () => {};
        const url = validateMichiEndpoint(server.url);
        if (server.headers?.length) throw new Error('Crew relay does not support MCP authentication headers');
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const session = `dashboard:${slot}`;
        const target = bindingPath(this.directory, session);
        const lease = randomUUID();
        const record = path.join(this.directory, `lease-${lease}.json`);
        await fs.writeFile(record, JSON.stringify({ session, url, owner: this.owner, lease, pid: process.pid, updated: Date.now() }), { mode: 0o600, flag: 'wx' });
        const temp = `${target}.${lease}.tmp`;
        await fs.writeFile(temp, JSON.stringify({ lease }), { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, target);
        this.sessions.set(slot, lease);
        return () => this.remove(slot, lease);
    }

    private async remove(slot: string, lease: string): Promise<void> {
        // Immutable lease files make cleanup race-free across adapter processes.
        // Leave the small pointer in place: a missing lease fails closed, and an
        // old process never unlinks a newer process's pointer or capability.
        await fs.unlink(path.join(this.directory, `lease-${lease}.json`)).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
        if (this.sessions.get(slot) === lease) this.sessions.delete(slot);
    }

    async close(): Promise<void> { await Promise.all([...this.sessions].map(([slot, lease]) => this.remove(slot, lease))); }
}

/** Only broker-injected metadata selects a binding. Never accept a tool argument or env fallback. */
export async function resolveCrewMcpEndpoint(meta: unknown, directory = crewMcpDirectory()): Promise<string> {
    const caller = (meta as Record<string, unknown> | undefined)?.['kirocrew.caller'] as Record<string, unknown> | undefined;
    if (!caller || typeof caller.schemaVersion !== 'number' || caller.schemaVersion < 1
        || caller.identityDenial || typeof caller.sessionKey !== 'string' || !caller.sessionKey.startsWith('dashboard:')) {
        throw new Error('Michi MCP needs the official Crew stdio broker with caller identity. Enable this server in MCP Management → Stub.');
    }
    const pointer = await readBindingFile(bindingPath(directory, caller.sessionKey));
    if (typeof pointer.lease !== 'string' || !/^[a-f0-9-]{36}$/.test(pointer.lease)) throw new Error('Invalid Michi lease');
    const entry = await readBindingFile(path.join(directory, `lease-${pointer.lease}.json`));
    if (entry.session !== caller.sessionKey || entry.lease !== pointer.lease || !Number.isInteger(entry.pid) || entry.pid <= 0
        || typeof entry.updated !== 'number' || Date.now() - entry.updated > MAX_AGE_MS) throw new Error('Michi session binding expired');
    process.kill(entry.pid, 0);
    return validateMichiEndpoint(entry.url);
}

async function readBindingFile(target: string): Promise<Record<string, any>> {
    const file = await fs.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid Michi session binding');
        return JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
}
