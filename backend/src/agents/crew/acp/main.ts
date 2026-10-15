/**
 * Entry point of the Crew ACP adapter process.
 *
 * Michi launches this like kiro-cli: `<node> crewAcp.js acp --agent-engine v2
 * [--model X]`. It speaks ACP on stdin/stdout and drives the local Kiro Crew
 * Gateway as the installed Crew app (default `michi-crew-runtime`).
 *
 * Environment:
 * - `CREW_GATEWAY_URL`  loopback Gateway URL (default http://127.0.0.1:$KIROCREW_PORT, port 5476)
 * - `KIROCREW_HOME`     Kiro Crew home (default ~/.kiro/crew)
 * - `MICHI_CREW_APP`    Crew app name (default michi-crew-runtime)
 * - `MICHI_CREW_AGENT`  explicit agent for new slots (otherwise prefer installed michi-crew)
 * - `MICHI_CREW_MEMORY_MODE` persistent (default), incognito, or temporary for new slots only
 */
import os from 'os';
import path from 'path';
import { runCrewAcpServer } from './acpServer';
import { createCrewGateway } from './gatewayClient';
import type { CrewGatewayConfig, CrewMemoryMode } from './gatewayTypes';
import { DEFAULT_CREW_APP } from '../crewLaunch';

export { DEFAULT_CREW_APP };

export interface CrewAcpLaunchConfig {
    gateway: CrewGatewayConfig;
    defaultModel?: string;
    memoryMode?: CrewMemoryMode;
}

/** Parse the kiro-cli style argv (`acp --agent-engine v2 [--model X]`) and env. */
export function parseCrewAcpConfig(argv: readonly string[], env: NodeJS.ProcessEnv): CrewAcpLaunchConfig {
    let defaultModel: string | undefined;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--model') {
            defaultModel = argv[i + 1] || undefined;
            i += 1;
        } else if (arg.startsWith('--model=')) {
            defaultModel = arg.slice('--model='.length) || undefined;
        } else if (arg === '--agent-engine') {
            i += 1;
        }
    }
    const port = env.KIROCREW_PORT?.trim() || '5476';
    const agent = env.MICHI_CREW_AGENT?.trim();
    const memoryMode = env.MICHI_CREW_MEMORY_MODE?.trim();
    if (memoryMode && !['persistent', 'incognito', 'temporary'].includes(memoryMode)) {
        throw new Error('MICHI_CREW_MEMORY_MODE must be persistent, incognito, or temporary');
    }
    return {
        gateway: {
            baseUrl: env.CREW_GATEWAY_URL?.trim() || `http://127.0.0.1:${port}`,
            appName: env.MICHI_CREW_APP?.trim() || DEFAULT_CREW_APP,
            kirocrewHome: env.KIROCREW_HOME?.trim() || path.join(os.homedir(), '.kiro', 'crew'),
            ...(agent ? { agent } : {}),
        },
        ...(defaultModel ? { defaultModel } : {}),
        ...(memoryMode ? { memoryMode: memoryMode as CrewMemoryMode } : {}),
    };
}

function log(message: string): void {
    process.stderr.write(`[crew-acp] ${message}\n`);
}

export function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): void {
    const config = parseCrewAcpConfig(argv, env);
    const gateway = createCrewGateway(config.gateway);
    const server = runCrewAcpServer({
        gateway,
        input: process.stdin,
        output: process.stdout,
        log,
        dashboardBaseUrl: new URL(config.gateway.baseUrl).origin,
        memoryMode: config.memoryMode,
        ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
        ...(config.gateway.agent ? { agent: config.gateway.agent } : {}),
    });
    const shutdown = () => { void server.shutdown().then(() => process.exit(0)); };
    // AcpClient and the dev watcher terminate adapter processes with SIGTERM,
    // which does not emit stdin's end event. Keep native stop/MCP cleanup on
    // the same path as EOF instead of abandoning a live Gateway turn.
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    process.stdout.on('error', shutdown);
    log(`ready: app ${config.gateway.appName} at ${config.gateway.baseUrl}`);
    void server.closed.then(() => process.exit(0));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        log(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
