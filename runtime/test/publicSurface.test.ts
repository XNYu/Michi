import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as root from '../src/index';
import * as mcpHost from '../src/mcp-host/index';
import * as claude from '../src/adapters/claude/index';
import * as codex from '../src/adapters/codex/index';
import * as kiro from '../src/adapters/kiro/index';
import * as crew from '../src/adapters/crew/index';
import * as acp from '../src/adapters/acp/index';
import type {
  ClaudeAdapterOptions, ClaudeAdapterOptionsInput, ClaudeCliFlags, ClaudeHostText, ClaudeLimits, ClaudeModelCatalogOptions,
  ClaudeModelProbe, ClaudeRuntimeOptions,
} from '../src/adapters/claude/index';
import type { CodexAdapterOptions, CodexHostText, CodexRuntimeOptions } from '../src/adapters/codex/index';
import type {
  AcpLaunch, AcpProcessOptions, KiroAcpAgentTurnHandler, KiroAcpAgentTurnUpdate, KiroAcpClient, KiroAcpClientOptions,
  KiroAcpInitializeResult, KiroAcpMcpServer, KiroAcpSessionOptions, KiroAcpWorkflowRouter, KiroAdapterOptions,
  KiroCliLookup, KiroDescriptorOverride, KiroEngine, KiroFlavor, KiroNewSessionMemory, KiroRuntimeOptions,
  KiroSessionMemory,
} from '../src/adapters/kiro/index';
import type { CrewAdapterOptions, CrewAppLocation, CrewLaunchResolution, CrewRuntimeOptions } from '../src/adapters/crew/index';
import type {
  ACPErrorDetails, AcpAgentCapabilities, AcpAuthMethod, AcpCancelOptions, AcpClientInfo, AcpConfigOption, AcpConfigValue,
  AcpCoreOptions, AcpHandlerContext, AcpIncomingMessage, AcpIncomingNotification, AcpIncomingRequest, AcpInitializeResult,
  AcpMcpAttach, AcpMcpCapabilities, AcpMcpServer, AcpPendingRequest, AcpPermissionRequest, AcpProfile, AcpPromptBlock,
  AcpPromptCapabilities, AcpRpcErrorPayload, AcpSessionInfo, AcpSessionOptions, AcpUpdate, AcpUserAnswer, SessionQueue,
  SessionQueueItem,
} from '../src/adapters/acp/index';
import type {
  McpSlotEventSink, RuntimeCatalogCache, RuntimeCatalogSnapshot, RuntimeErrorCategory, RuntimeModelCache,
  // Wire types the contract modules re-export.
  AgentSessionState, JsonValue, EventConfidence, EventSource, RuntimeReasoning, ModelReasoningCapabilities,
  WebSearchProviderInfo,
  UsageCharge, RuntimeWarning, SteeringReport, UserInputOption, SubagentActivity, SubagentActivityKind, SubagentOutcome,
  SubagentSource, SubagentStatus, SubagentUsage,
  ChatPermissionMode, CrewMemoryMode, SubagentEnd, WorkflowAction, WorkflowApprovalDto, WorkflowApprovalOption,
  WorkflowLogEntry, WorkflowNodeDto, WorkflowNodeKind, WorkflowNodeStatus, WorkflowRunDtoV1, WorkflowRunStatus,
  WorkflowRuntime, WorkflowUsage,
  CapabilityDescriptor, CapabilityKey, CapabilitySlot, CapabilityAvailability,
  ResultBundleV1, ResultBundleStatus, ResultArtifactRefV1, GitChangeSetRefV1, ExternalActionReceiptV1,
  ResourceMutationReceiptV1, RunUsageSummaryV1,
} from '../src/index';
import type { McpHost, McpSlotHandle, McpSlotProviderOptions } from '../src/mcp-host/index';

// The type exports the adapters' options, the ACP core's extension points and
// the host's MCP slot callbacks reference, directly or through another
// exported type, every type of the acp entry, and the wire types and Kiro ACP
// client types the public declarations reach; typecheck fails if one goes
// missing.
export type PublicTypeExports = [
  ClaudeAdapterOptions, ClaudeAdapterOptionsInput, ClaudeCliFlags, ClaudeHostText, ClaudeLimits, ClaudeModelCatalogOptions,
  ClaudeModelProbe, ClaudeRuntimeOptions, CodexAdapterOptions, CodexHostText, CodexRuntimeOptions,
  AcpLaunch, AcpProcessOptions, KiroAcpClient, KiroAdapterOptions, KiroCliLookup, KiroDescriptorOverride, KiroEngine,
  KiroFlavor, KiroNewSessionMemory, KiroRuntimeOptions, KiroSessionMemory,
  KiroAcpAgentTurnHandler, KiroAcpAgentTurnUpdate, KiroAcpClientOptions, KiroAcpInitializeResult, KiroAcpMcpServer,
  KiroAcpSessionOptions, KiroAcpWorkflowRouter,
  CrewAdapterOptions, CrewAppLocation, CrewLaunchResolution, CrewRuntimeOptions,
  ACPErrorDetails, AcpAgentCapabilities, AcpAuthMethod, AcpCancelOptions, AcpClientInfo, AcpConfigOption, AcpConfigValue,
  AcpCoreOptions, AcpHandlerContext, AcpIncomingMessage, AcpIncomingNotification, AcpIncomingRequest, AcpInitializeResult,
  AcpMcpAttach, AcpMcpCapabilities, AcpMcpServer, AcpPendingRequest, AcpPermissionRequest, AcpProfile, AcpPromptBlock,
  AcpPromptCapabilities, AcpRpcErrorPayload, AcpSessionInfo, AcpSessionOptions, AcpUpdate, AcpUserAnswer, SessionQueue,
  SessionQueueItem,
  McpSlotEventSink, RuntimeCatalogCache, RuntimeCatalogSnapshot, RuntimeErrorCategory, RuntimeModelCache,
  McpHost<unknown>['slotEndpoint'], McpHost<unknown>['sessionGroupEndpoint'], McpHost<unknown>['hookUrl'],
  NonNullable<Parameters<McpSlotHandle<unknown>['rebind']>[0]['allowTools']>, McpSlotProviderOptions,
  AgentSessionState, JsonValue, EventConfidence, EventSource, RuntimeReasoning, ModelReasoningCapabilities,
  WebSearchProviderInfo,
  UsageCharge, RuntimeWarning, SteeringReport, UserInputOption, SubagentActivity, SubagentActivityKind, SubagentOutcome,
  SubagentSource, SubagentStatus, SubagentUsage,
  ChatPermissionMode, CrewMemoryMode, SubagentEnd, WorkflowAction, WorkflowApprovalDto, WorkflowApprovalOption,
  WorkflowLogEntry, WorkflowNodeDto, WorkflowNodeKind, WorkflowNodeStatus, WorkflowRunDtoV1, WorkflowRunStatus,
  WorkflowRuntime, WorkflowUsage,
  CapabilityDescriptor, CapabilityKey, CapabilitySlot, CapabilityAvailability,
  ResultBundleV1, ResultBundleStatus, ResultArtifactRefV1, GitChangeSetRefV1, ExternalActionReceiptV1,
  ResourceMutationReceiptV1, RunUsageSummaryV1,
];

/**
 * The value exports of each public entry. Adding one is a new feature;
 * removing or renaming one breaks hosts, so it needs a contract version bump.
 * Type exports beyond PublicTypeExports are left to the d.ts build.
 */
const valueNames = (entry: object) => Object.keys(entry).filter((name) => name !== '__esModule').sort();

describe('public surface', () => {
  it('the root entry exports the contract and core', () => {
    assert.deepEqual(valueNames(root), [
      'AGENT_RUN_TOOL_NAMES', 'ApprovalCoordinator', 'CHAT_APPROVAL_OPTION_IDS', 'DEFAULT_HEADLESS_DRIVER_MESSAGES',
      'FileRuntimeCatalogCache', 'HISTORY_STUB_MAX_ENTRIES', 'HISTORY_STUB_TTL_MS', 'NativeResumeFailedError',
      'NativeResumeUnavailableError', 'RUNTIME_CONTRACT_VERSION', 'ReportedRuntimeError', 'RuntimeHostConfigError',
      'SUBMIT_AGENT_RESULT_TOOL', 'SessionProfileUnsupportedError', 'UNKNOWN_HARNESS', 'UNKNOWN_RUNTIME_DESCRIPTOR',
      'approvalCoversTool', 'assertHostPorts', 'assertOwner', 'chatApprovalOptions', 'classifyRuntimeError',
      'createDefaultHost', 'createRuntimeManager', 'createSessionDirectory', 'createSessionStateFeed',
      'decisionToOptionId', 'descriptorOf', 'hasProviders', 'interactiveOwner', 'isPermissionOptionId', 'ownerLabel',
      'ownerMode', 'resolveAgentRunToolsForSession', 'sameOwner', 'startHeadlessSession',
    ]);
  });

  it('./mcp-host exports the MCP host factory, whose host has these members, and the slot provider on it', () => {
    assert.deepEqual(valueNames(mcpHost), ['createMcpHost', 'createMcpSlotProvider']);
    const host = mcpHost.createMcpHost();
    assert.deepEqual(Object.keys(host).sort(), [
      'close', 'createSessionGroup', 'createSlot', 'handler', 'hookUrl', 'listen', 'registerHook', 'registerTool',
      'registerToolSource', 'sessionGroupEndpoint', 'slotEndpoint',
    ]);
    // McpSlotProvider's members and nothing else.
    assert.deepEqual(Object.keys(mcpHost.createMcpSlotProvider(host as Parameters<typeof mcpHost.createMcpSlotProvider>[0])).sort(), [
      'beginSessionTurn', 'bindSession', 'create', 'createSessionGroup', 'dispose', 'disposeSessionGroup', 'endSessionTurn',
      'endpoint', 'get', 'hookEndpoint', 'rebind', 'sessionEndpoint',
    ]);
    void host.close();
  });

  it('./adapters/claude exports the Claude runtime, its errors, its descriptor and its default options', () => {
    assert.deepEqual(valueNames(claude), [
      'CLAUDE_RUNTIME_DESCRIPTOR', 'ClaudeConcurrencyError', 'ClaudeRuntime', 'ClaudeSdkMissingError',
      'ClaudeSessionNotResumableError', 'DEFAULT_CLAUDE_CLI_FLAGS', 'DEFAULT_CLAUDE_LIMITS', 'claudeAdapterOptions',
    ]);
  });

  it('./adapters/codex exports the Codex runtime, its errors and its descriptor', () => {
    assert.deepEqual(valueNames(codex), [
      'CODEX_RUNTIME_DESCRIPTOR', 'CodexConcurrencyError', 'CodexRuntime', 'CodexSessionNotResumableError',
    ]);
  });

  it('./adapters/kiro exports the Kiro runtime, its errors, engine, descriptor and flavor', () => {
    assert.deepEqual(valueNames(kiro), [
      'KIRO_FLAVOR', 'KIRO_STATIC_DESCRIPTOR', 'KiroConcurrencyError', 'KiroProcessCapError', 'KiroRuntime',
      'resolveKiroEngine',
    ]);
  });

  it('./adapters/crew exports createCrewRuntime, the pieces it passes KiroRuntime and its launch lookup', () => {
    assert.deepEqual(valueNames(crew), [
      'CREW_DESCRIPTOR_OVERRIDE', 'CREW_KIRO_FLAVOR', 'CREW_STATIC_DESCRIPTOR', 'DEFAULT_CREW_APP', 'createCrewRuntime',
      'crewAvailability', 'resolveCrewAcpLaunch',
    ]);
  });

  it('./adapters/acp exports the ACP client core and its errors', () => {
    assert.deepEqual(valueNames(acp), [
      'ACPError', 'ACPNativeSessionMissingError', 'ACPNotRunningError', 'ACPProcessExitedError', 'ACPRequestNotSentError',
      'ACPSessionRecoveryRequiredError', 'ACPUnsupportedMethodError', 'AcpClient',
    ]);
  });
});
