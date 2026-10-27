export { RUNTIME_CONTRACT_VERSION } from './version';

// Host-facing contract: interfaces and event types, plus side-effect-free
// helpers and error classes that adapters and hosts share.
export * from './contract/types';
export * from './contract/events';
export * from './contract/errors';

// Instance-scoped runtime registry and session directory. Factories only: no
// module-level state, so several isolated managers can share one process.
export * from './core/runtimeManager';
export * from './core/sessionDirectory';
export * from './core/sessionStateFeed';
// Headless session driver for unattended hosts (batch jobs, scheduled runs).
export * from './core/headless/driver';
export * from './core/headless/errors';
// Persistent model catalog the CLI adapters share (their options take a RuntimeModelCache).
export {
  FileRuntimeCatalogCache, type RuntimeCatalogCache, type RuntimeCatalogSnapshot, type RuntimeModelCache,
} from './core/runtimeModelCache';

export * from './contract/descriptor';
export { descriptorOf, UNKNOWN_HARNESS, UNKNOWN_RUNTIME_DESCRIPTOR } from './core/descriptors';

// Host ports: what adapters need from the embedding application.
export * from './contract/host';
export { createDefaultHost, assertHostPorts, type DefaultHostOptions, type DefaultHostPortOverrides } from './core/defaultHost';

// MCP slot provider and tool-name contracts: the host's MCP slots and the
// tool names, bridge and result tool that adapters and host tools share.
export * from './contract/mcp';
export * from './contract/tools';

// Permission option ids sessions accept, and the broker decision mapping.
export * from './contract/permissions';

// Chat approvals: one-time, session and always-allow answers over the host permission port.
export * from './core/approvals';
