import { runCrewMcpRelay } from './crewMcpRelay';
export { CREW_MCP_HANDLER_API, createCrewMcpHandlers, runCrewMcpRelay } from './crewMcpRelay';

if (require.main === module) void runCrewMcpRelay().catch(() => { process.exitCode = 1; });
