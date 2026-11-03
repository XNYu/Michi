// Public entry of the Kiro adapter (`michi-runtime/adapters/kiro`).
import { AcpAgentRuntime } from './AcpAgentRuntime';
import type { AcpAgentFlavor } from './acpAgentFlavor';
export { AcpAgentRuntime, KiroConcurrencyError, KiroProcessCapError } from './AcpAgentRuntime';
export type { KiroAdapterOptions, KiroRuntimeOptions } from './AcpAgentRuntime';
/** @deprecated Renamed AcpAgentRuntime: Kiro CLI, Kiro Crew and Antigravity share it. */
export const KiroRuntime = AcpAgentRuntime;
/** @deprecated Renamed AcpAgentRuntime. */
export type KiroRuntime = AcpAgentRuntime;
/** @deprecated Renamed AcpAgentFlavor. */
export type KiroFlavor = AcpAgentFlavor;
export { resolveKiroEngine, type KiroEngine } from './kiroProtocol';
export { KIRO_STATIC_DESCRIPTOR, type KiroDescriptorOverride } from './kiroDescriptor';
export { KIRO_FLAVOR, type KiroCancelAck, type AcpAgentFlavor, type KiroNewSessionMemory, type KiroSessionMemory } from './acpAgentFlavor';
export type { AcpLaunch } from './kiroAcpProfile';
export type { AcpClient as KiroAcpClient, AcpProcessOptions } from './acpClient';
// What KiroAcpClient's constructor and methods take and return. Kiro's own
// versions of a few ACP types, so they carry its prefix beside ./adapters/acp's.
export type {
  AcpClientOptions as KiroAcpClientOptions, AcpWorkflowRouter as KiroAcpWorkflowRouter,
  AcpToolCatalogState as KiroAcpToolCatalogState,
} from './acpClient';
export type {
  AcpAgentTurnHandler as KiroAcpAgentTurnHandler, AcpAgentTurnUpdate as KiroAcpAgentTurnUpdate,
} from './acpAgentTurns';
export type {
  AcpInitializeResult as KiroAcpInitializeResult, AcpMcpServer as KiroAcpMcpServer,
  AcpSessionOptions as KiroAcpSessionOptions,
} from './kiroProtocol';
export type { KiroCliLookup } from './kiroCli';
