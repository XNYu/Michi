import path from 'node:path';

// Adapter files that tests spawn, bundle or read by path rather than import.
// They are named here once, so a test follows an adapter wherever its
// directory lives; backend/test/helpers/adapterPaths.ts re-exports them.

const ADAPTERS = path.resolve(__dirname, '../../src/adapters');

/** Kiro Crew's ACP adapter entry; crewAcpLifecycle runs it under ts-node. */
export const CREW_ACP_MAIN = path.join(ADAPTERS, 'crew/acp/main.ts');

/** The two entries build.mjs bundles as dist/crewMcp.js and dist/crewMcpHost.js. */
export const CREW_MCP_MAIN = path.join(ADAPTERS, 'crew/crewMcpMain.ts');
export const CREW_MCP_HOST = path.join(ADAPTERS, 'crew/crewMcpHost.ts');

/** Source of Codex's event translator; codexContract reads its method and item literals. */
export const CODEX_EVENT_TRANSLATOR = path.join(ADAPTERS, 'codex/codexEventTranslator.ts');

/** The script Codex's Stop hook runs (build.mjs copies it into dist/). */
export const CODEX_STOP_HOOK_RUNNER = path.join(ADAPTERS, 'codex/assets/codexStopHookRunner.cjs');
