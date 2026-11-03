// What the published package contains, shared by scripts/build.mjs and scripts/pack.mjs.

/**
 * The subpaths the published package exports, each with its entry module
 * under src/ (and dist/), without extension. Only these are reachable from a
 * host; everything else in dist/ is private to the package.
 */
export const PUBLIC_ENTRIES = [
  ['.', 'index'],
  ['./mcp-host', 'mcp-host/index'],
  ['./adapters/kiro', 'adapters/kiro/index'],
  ['./adapters/crew', 'adapters/crew/index'],
  ['./adapters/antigravity', 'adapters/antigravity/index'],
  ['./adapters/codex', 'adapters/codex/index'],
  ['./adapters/claude', 'adapters/claude/index'],
  ['./adapters/acp', 'adapters/acp/index'],
];

/**
 * Crew's process entries (each guarded by require.main === module) and the
 * self-contained CommonJS bundle each becomes in dist/adapters/crew/.
 */
export const CREW_BUNDLES = [
  ['adapters/crew/acp/main.ts', 'crewAcp.js'], // spawned by crewLaunch
  ['adapters/crew/crewMcpMain.ts', 'crewMcp.js'], // loaded by crewMcpHost as CommonJS through vm
  // Started by the Crew App's launcher. It replaces tsc's crewMcpHost.js, which
  // no module of the package imports.
  ['adapters/crew/crewMcpHost.ts', 'crewMcpHost.js'],
];

/**
 * The line that opens the notices scripts/build.mjs appends to each Crew
 * bundle: one entry per license or NOTICE file of each package it inlines,
 * `// --- <name>@<version> (<SPDX expression>): <file> ---` and that file's
 * text, every line a `//` comment ending in \n. scripts/pack.mjs checks them
 * in the tarball.
 */
export const LICENSE_NOTICES_HEADER = '// Third-party notices: the packages this bundle inlines, with their license files.';
export const LICENSE_NOTICE_ENTRY = /^\/\/ --- (\S+)@(\S+) \((.*)\): (\S+) ---$/;

/** Files under src/ that are not TypeScript and that adapters read at run time, copied to the same path in dist/. */
export const ASSETS = [
  // Codex's Stop hook runs it; codexFollowUpsHookPoc looks in assets/ beside itself.
  'adapters/codex/assets/codexStopHookRunner.cjs',
];

/**
 * The files under src/ that may mark declarations @internal, which
 * tsconfig.build.json's stripInternal leaves out of dist/'s .d.ts, each with
 * how many marks it holds. scripts/build.mjs fails on a mark in any other
 * file and on any other count: a public declaration marked by mistake would
 * vanish from the published types without an error, even in a listed file.
 */
export const INTERNAL_MARKERS = {
  // CodexRuntime's test seams: the CodexRuntimeTestSeams interface and the
  // constructor overload that takes it.
  'adapters/codex/CodexRuntime.ts': 2,
};

/**
 * The types the public declarations reach that no public entry exports, each
 * with why, keyed `<module under dist/, without .d.ts>#<name>`. scripts/pack.mjs
 * fails when the declarations reach any other unexported type, and when an
 * entry here is no longer reached unexported. A new type in a public
 * signature is exported, or listed here with its reason.
 */
const KIRO_EXTRAS = "used only by KiroRuntime's members that AgentRuntime does not declare: "
  + "Michi's own wiring of Kiro, outside the v1 guarantee (README)";
export const REACHABLE_UNEXPORTED = {
  'adapters/kiro/KiroRuntime#KiroSessionBinding': KIRO_EXTRAS,
  'adapters/kiro/KiroRuntime#LoadSessionResult': KIRO_EXTRAS,
  'adapters/kiro/KiroRuntime#McpSlotCallbacksFactory': KIRO_EXTRAS,
  'adapters/kiro/KiroRuntime#OpenSessionResult': KIRO_EXTRAS,
  'adapters/kiro/KiroSession#KiroSession': KIRO_EXTRAS,
  'core/defaultHost#PortOverride': "the mapped type behind DefaultHostPortOverrides; a host writes DefaultHostPortOverrides['<port>']",
  'vendor/michi-shared/harness#CAPABILITY_KEYS': 'a value, reached only as typeof CAPABILITY_KEYS[number] in CapabilityKey, which is exported',
  'vendor/michi-shared/reasoning#REASONING_LEVELS': 'a value, reached only as typeof REASONING_LEVELS[number] in RuntimeReasoning, which is exported',
  'vendor/michi-shared/runtimeContracts#AgentModelInfo': 'exported as ModelInfo (export type ModelInfo = AgentModelInfo)',
};

/**
 * Modules of Michi's shared package that hold Michi's product code: remote
 * access and its sign-in and credential providers, the desktop app, Desk,
 * scheduled jobs and the assistant. None may ship: scripts/build.mjs fails if
 * the vendored copy of shared would need one, and scripts/pack.mjs if the
 * tarball holds one.
 */
export const EXCLUDED_SHARED_MODULES = [
  'assistant', 'desktopContracts', 'michiPreamble',
  'metaAgent', 'metaAgentChat', 'metaAgentOverview', 'homeCards', 'pages', 'databaseModel', 'database/viewModel',
  'remoteCredentials', 'remoteDiagnostics', 'remoteSignIn', 'remoteUpdate', 'scheduledJobs',
];
