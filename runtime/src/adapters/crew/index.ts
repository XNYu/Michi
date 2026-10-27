// Public entry of the Kiro Crew preset (`michi-runtime/adapters/crew`):
// createCrewRuntime, and the pieces it passes KiroRuntime to run Kiro Crew
// through its ACP adapter. The adapter's own processes (crewAcp, crewMcp,
// crewMcpHost) are files, not entries.
export { createCrewRuntime, type CrewRuntimeOptions } from './crewRuntime';
export { CREW_KIRO_FLAVOR } from './crewFlavor';
export { CREW_DESCRIPTOR_OVERRIDE, CREW_STATIC_DESCRIPTOR } from './crewDescriptor';
export { DEFAULT_CREW_APP, crewAvailability, resolveCrewAcpLaunch } from './crewLaunch';
export type { CrewAdapterOptions, CrewAppLocation, CrewLaunchResolution } from './crewLaunch';
