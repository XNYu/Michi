import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCrewMcpRelay, CREW_MCP_HANDLER_API, type CrewMcpHandlers } from './crewMcpRelay';

/**
 * Keep the approved broker transport alive while replacing stateless handlers.
 * Each request keeps its captured generation; updates cannot interrupt it.
 */
export function createCrewMcpLoader(bundle: string, directory?: string): () => Promise<CrewMcpHandlers> {
    let loaded = '';
    let current: CrewMcpHandlers | undefined;
    let updating: Promise<CrewMcpHandlers> | undefined;
    const load = async () => {
        let source: string;
        try { source = await fs.readFile(bundle, 'utf8'); }
        catch (error) {
            // Normal builds temporarily remove dist. Existing calls remain usable.
            if (current && ['ENOENT', 'EACCES', 'EBUSY'].includes(String((error as NodeJS.ErrnoException).code))) return current;
            throw error;
        }
        if (current && source === loaded) return current;
        try {
            // Fresh CommonJS scope; old requests retain their own module closures.
            const module = { exports: {} as { CREW_MCP_HANDLER_API?: number; createCrewMcpHandlers?: (dir?: string) => CrewMcpHandlers } };
            const localRequire = createRequire(bundle);
            const wrapper = vm.runInThisContext(`(function(exports,require,module,__filename,__dirname){${source}\n})`, { filename: bundle });
            wrapper(module.exports, localRequire, module, bundle, path.dirname(bundle));
            if (module.exports.CREW_MCP_HANDLER_API !== CREW_MCP_HANDLER_API) throw new Error('Unsupported Crew relay API');
            const next = module.exports.createCrewMcpHandlers?.(directory);
            if (!next || typeof next.listTools !== 'function' || typeof next.callTool !== 'function') throw new Error('Unsupported Crew relay module');
            current = next;
            loaded = source;
            return next;
        } catch (error) {
            if (current) return current; // A partial write must not poison a working connection.
            throw error;
        }
    };
    return () => {
        if (!updating) updating = load().finally(() => { updating = undefined; });
        return updating;
    };
}

export async function runCrewMcpHost(): Promise<void> {
    const load = createCrewMcpLoader(path.join(__dirname, 'crewMcp.js'));
    await load();
    await createCrewMcpRelay(undefined, load).connect(new StdioServerTransport());
}

if (require.main === module) void runCrewMcpHost().catch(() => {
    console.error('Michi MCP host failed to start. Update Michi and check the Crew App launcher.');
    process.exitCode = 1;
});
