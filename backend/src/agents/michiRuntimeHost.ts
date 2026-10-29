import * as maintenancePolicy from './maintenancePolicy';
import * as metaAgentGuard from './metaAgentGuard';
import type {
  BackgroundSubagentContext, BackgroundSubagentSink, BackgroundTurn, RuntimeHost, RuntimeLogLevel, RuntimeSessionOwner,
  WorkflowRunSink,
} from 'michi-runtime';
import { ownerMode } from 'michi-runtime';
import * as agentConfig from '../services/agentConfig';
import * as agentOwner from '../services/agentOwner';
import * as backgroundSubagentRegistry from '../services/backgroundSubagentRegistry';
import * as branchBoundary from '../services/branchBoundary';
import * as claudeForkAnchors from '../services/claudeForkAnchors';
import * as crewMemory from '../services/crewMemory';
import * as dataDir from '../services/dataDir';
import * as dbRepository from '../services/dbRepository';
import * as kiroForkAnchors from '../services/kiroForkAnchors';
import * as logger from '../services/logger';
import * as perf from '../services/perf';
import * as sessionStatePersistence from '../services/sessionStatePersistence';
import * as startupTrace from '../services/startupTrace';
import * as streamProbe from '../services/streamProbe';
import * as titleGeneration from '../services/titleGeneration';
import * as workflowRunHub from '../services/workflowRunHub';
import * as assistantIdentity from '../assistant/identity';
import * as assistantPolicy from '../assistant/policy';
import { michiPermissionPolicy } from './chatApprovalState';
import { chatNodeOf, isRunOwner } from './ownerMapping';
import * as followUpsExperiment from './followUpsExperiment';
import * as kiroHostText from './hostText/kiro';
import * as nodeSummaryExperiment from './nodeSummaryExperiment';
import * as preamble from './preamble';
import * as sessionRegistry from './sessionRegistry';
import * as turnMetadataState from './turnMetadataState';

type LogStage = Parameters<typeof logger.log.info>[0];
type TitleRuntimeId = Parameters<typeof titleGeneration.titleModelConfig>[0];

/**
 * The runtime host ports over Michi's own modules. Every method calls the
 * app function an adapter calls today, with the same arguments, and returns
 * or throws what it does. Calls go through the module objects, so test stubs
 * of those functions (t.mock.method) still apply.
 *
 * The session profile is the Michi assistant (assistant/policy.ts).
 * `interaction` is left out: Michi answers questions through the session's
 * own user_input_request events and AgentSession.respondToUserInput.
 */
export function createMichiRuntimeHost(): RuntimeHost {
  return {
    config: {
      defaultModel: (runtimeId, userId) => agentConfig.resolveModel(runtimeId, userId ?? undefined),
      defaultReasoning: (runtimeId, userId) => agentConfig.resolveReasoning(runtimeId, userId ?? undefined),
      // titleModelConfig knows only the sidecar-title runtimes; others generate none.
      titleModel: (runtimeId) => titleGeneration.titleModelConfig(runtimeId as TitleRuntimeId)
        ?? { model: null, timeoutMs: titleGeneration.DEFAULT_TITLE_TIMEOUT_MS },
      onDefaultModelChanged: (listener) => {
        agentConfig.agentConfigEvents.on('model_changed', listener);
        return () => { agentConfig.agentConfigEvents.off('model_changed', listener); };
      },
      features: {
        workflows: (...args) => agentConfig.isWorkflowsEnabled(...args),
      },
      dataDir: () => dataDir.getMichiDataDir(),
    },
    prompt: {
      firstTurnPrefix: (input) => preamble.buildFirstTurnPrefix(input),
      preamble: ({ toolProfile, ...input }) => preamble.buildPreamble({ ...input, ...((metaAgentGuard.isMetaAgentProfile(toolProfile) || assistantPolicy.isAssistantProfile(toolProfile)) ? { toolCapabilities: maintenancePolicy.isMaintenanceProfile(toolProfile) ? 'maintenance' : 'assistant' } : {}) }),
      // The assistant gets its own short tool note instead of the ordinary chat tools.
      stableSystemPrompt: (metadataOutputMode, enableFollowUps, nativeAskUser, restricted, profile) => preamble.buildStableSystemPrompt(
        metadataOutputMode, enableFollowUps, nativeAskUser, maintenancePolicy.isMaintenanceProfile(profile) ? 'maintenance' : (restricted || assistantPolicy.isAssistantProfile(profile)) ? 'assistant' : undefined,
      ),
      // As KiroSession.send builds it: Crew's inline answer format (none for
      // Agent Runs), else the follow-up reminder and the set_branch_overview note.
      turnSuffix: ({ metadataChannel, userTurnCount, enableFollowUps, owner }) => {
        if (metadataChannel === 'inline') return isRunOwner(owner) ? '' : kiroHostText.crewTurnFormat(enableFollowUps);
        return (preamble.followUpReminder(userTurnCount, enableFollowUps) || '')
          + (nodeSummaryExperiment.fullNodeSummaryExperimentEnabled()
            ? kiroHostText.FULL_BRANCH_OVERVIEW_TOOL_REMINDER
            : kiroHostText.BRANCH_OVERVIEW_TOOL_REMINDER);
      },
      followUpsExperimentMode: () => followUpsExperiment.resolveFollowUpsExperimentMode(),
      followUpsMetadataOutputMode: (...args) => followUpsExperiment.followUpsMetadataOutputMode(...args),
      followUpsTurnReminder: (...args) => followUpsExperiment.followUpsTurnReminder(...args),
      mcpSessionReminder: (nativeSessionId) => kiroHostText.kiroMcpSessionReminder(nativeSessionId),
      toolResultForDisplay: (output) => kiroHostText.kiroToolResultForDisplay(output),
      renderBranchContext: (...args) => branchBoundary.renderBranchContext(...args),
      workspaceInstructions: (workspaceId) => dbRepository.getWorkspaceInstructions(workspaceId),
      turnMetadata: (mode) => new turnMetadataState.TurnMetadataState(mode),
    },
    profile: {
      isRestricted: (toolProfile) => toolProfile?.restricted === true || metaAgentGuard.isMetaAgentProfile(toolProfile),
      isMaintenance: maintenancePolicy.isMaintenanceProfile,
      toolset: metaAgentGuard.metaAgentToolsetOf,
      maintenancePromptPrefix: maintenancePolicy.maintenancePromptPrefix,
      assertToolCatalog: metaAgentGuard.assertMetaAgentToolCatalog,
      catalogUnavailable: (runtimeId, toolset, detail) => metaAgentGuard.metaAgentCatalogUnavailable(runtimeId, toolset as 'chat' | 'maintenance', detail),
      isGuardError: metaAgentGuard.isMetaAgentGuardError,
      guardError: (v) => new metaAgentGuard.MetaAgentGuardError({ ...v, toolset: v.toolset as 'chat' | 'maintenance' }),
      isRestrictedWorkspace: (workspaceId) => assistantIdentity.isAssistantWorkspace(workspaceId),
      composeFirstTurnPrefix: (...args) => assistantPolicy.chatFirstTurnPrefix(...args),
      unsupportedError: (runtimeId, profile) => maintenancePolicy.isMaintenanceProfile(profile)
        ? new maintenancePolicy.MaintenanceRuntimeUnsupportedError(runtimeId)
        : new assistantPolicy.AssistantRuntimeUnsupportedError(runtimeId),
    },
    bindings: {
      nodeBinding: (nodeId) => dbRepository.getNode(nodeId),
      workspace: (workspaceId) => dbRepository.getWorkspace(workspaceId),
      edges: (workspaceId) => dbRepository.listEdges(workspaceId),
      recordNativeSessionId: (owner, nativeSessionId) => dbRepository.setNodeExternalSessionId(boundChatNode(owner), nativeSessionId),
      forkAnchors: {
        saveKiroForkAnchor: (input) => kiroForkAnchors.saveKiroForkAnchor(input),
        readKiroForkAnchor: (nodeId, nativeSessionId, engine, messageId) =>
          kiroForkAnchors.readKiroForkAnchor(nodeId, nativeSessionId, engine, messageId),
        saveClaudeForkAnchor: (input) => claudeForkAnchors.saveClaudeForkAnchor(input),
        readClaudeForkAnchor: (input) => claudeForkAnchors.readClaudeForkAnchor(input),
      },
      crewMemory: {
        defaultMode: (userId) => crewMemory.defaultCrewMemory(userId),
        pin: (nodeId, mode) => crewMemory.pinCrewMemory(nodeId, mode),
      },
    },
    // The process-wide session registry, the one Michi's routes and services read too.
    sessions: {
      ensureAncestorChainLoaded: (chatId) => sessionRegistry.ensureAncestorChainLoaded(chatId),
      getSession: (chatId) => sessionRegistry.getSession(chatId),
      getAncestors: (chatId) => sessionRegistry.getAncestors(chatId),
      // Spread: the adapters pass ownerUserId alone or with an owner, and the registry sees the same arguments.
      registerSession: (...args) => sessionRegistry.registerSession(...args),
      dropSession: (chatId) => sessionRegistry.dropSession(chatId),
    },
    // The one implementation, shared with the sessions' ChatApprovalState.
    permissions: michiPermissionPolicy,
    principal: {
      resolve: (ownerUserId) => ownerUserId ?? agentOwner.LOCAL_AGENT_OWNER_ID,
      workspaceOwnerMatches: (...args) => agentOwner.workspaceOwnerMatches(...args),
      // Read at call time, as each adapter call site reads it today.
      enforceUserOwnership: () => process.env.MICHI_CLOUD === '1',
    },
    observability: {
      log: (level: RuntimeLogLevel, scope, msg, data) => logger.log[level](scope as LogStage, msg, data),
      perf: {
        now: () => perf.now(),
        mark: (...args) => perf.mark(...args),
        measure: (...args) => perf.measure(...args),
      },
      startupMark: (...args) => startupTrace.startupMark(...args),
      streamProbe: {
        enabled: () => streamProbe.BACKEND_STREAM_PROBE_ENABLED,
        write: (row) => streamProbe.writeBackendStreamProbe(row),
      },
      // kiro-cli.log is the only child log; every ACP child (Kiro, Crew) writes there.
      childStderr: (_runtimeId, chunk) => logger.log.acpStderr(chunk),
    },
    title: {
      // Michi titles every chat; the runtimes keep their own gates (Kiro needs a title model).
      enabled: () => true,
      prompt: (...args) => titleGeneration.buildTitlePrompt(...args),
    },
    backgroundTurns: {
      consume: (turn) => consumeBackgroundTurn(turn),
      isActive: (chatId) => chatHub().isActive(chatId),
      isOwnerTurnActive: (chatId) => chatHub().isOwnerTurnActive(chatId),
      hasPendingSelfTurn: (chatId) => chatHub().hasPendingSelfTurn(chatId),
    },
    workflows: michiWorkflowSink(() => workflowRunHub.workflowRunHub),
    backgroundSubagents: michiSubagentSink(() => backgroundSubagentRegistry.backgroundSubagentRegistry),
    // Nothing in Michi reads this port: Michi's runtime manager uses sessionRegistry's directory,
    // whose stateFeed (./sessionStateFeed) persists through runtime deps (server.ts), the same
    // persistSessionState. Other hosts receive state through a directory built with the host:
    // createDefaultHost's sessions port, or the one createRuntimeManager({ host }) builds for a
    // host's own sessions port.
    onSessionStateChanged: (...args) => sessionStatePersistence.persistSessionState(...args),
  };
}

/**
 * Loaded on first use. The adapters import chatHub too, and W3-F builds this
 * host where they are constructed; a lazy load keeps a cycle between the two
 * from breaking module initialization. This does not keep the host light:
 * the static imports of adapter-owned prompt text above still bring in
 * adapter modules. Kiro's turn reminders now live in hostText/kiro; W3-F
 * moves the rest into app-side modules the same way.
 */
function chatHub(): typeof import('./chatHub')['chatHub'] {
  return (require('./chatHub') as typeof import('./chatHub')).chatHub;
}

// ---- Owners ------------------------------------------------------------------
// The ports name a session's owner, by mode and key; Michi's stores and hubs
// are keyed by the chat node it stands for (ownerMapping).

/** The chat node an owner's native session id is bound on. An Agent Run has no binding: throws. */
function boundChatNode(owner: RuntimeSessionOwner): string {
  const nodeId = chatNodeOf(owner);
  if (nodeId === undefined) throw new Error('Only a chat session records a native session id');
  return nodeId;
}

/** A chat's turn starts in chatHub; one Michi cannot place is cancelled and drained (BackgroundTurnConsumer). */
function consumeBackgroundTurn({ owner, ...turn }: BackgroundTurn): void {
  const nodeId = chatNodeOf(owner);
  if (nodeId !== undefined) return chatHub().startSelfTurn({ ...turn, nodeId });
  void (async () => {
    try { await turn.cancel?.(); } catch { /* draining still ends it */ }
    try {
      for await (const discarded of turn.events) void discarded;
    } catch { /* the turn is discarded either way */ }
    logger.log.warn('chat', 'background turn discarded: its owner is not a chat', { chatId: turn.chatId, mode: ownerMode(owner) });
  })();
}

/** Michi's workflow run hub as the workflow port: a run shows on the chat node its owner stands for. */
export function michiWorkflowSink(hub: () => workflowRunHub.WorkflowRunHub): WorkflowRunSink {
  return {
    update: ({ owner, ...context }, ...args) => hub().update({ ...context, nodeId: chatNodeOf(owner) ?? null }, ...args),
    updateKnown: (...args) => hub().updateKnown(...args),
    registerControls: (...args) => hub().registerControls(...args),
    requestApproval: (...args) => hub().requestApproval(...args),
    withdrawApproval: (...args) => hub().withdrawApproval(...args),
    releaseControls: (...args) => hub().releaseControls(...args),
  };
}

/** Michi's background subagent registry as the subagent port: they belong to a chat, and an Agent Run reports none. */
export function michiSubagentSink(registry: () => backgroundSubagentRegistry.BackgroundSubagentRegistry): BackgroundSubagentSink {
  const michi = ({ owner, ...context }: BackgroundSubagentContext): backgroundSubagentRegistry.BackgroundSubagentContext | null => {
    const nodeId = chatNodeOf(owner);
    return nodeId === undefined ? null : { ...context, nodeId };
  };
  return {
    report: (context, ...args) => {
      const mapped = michi(context);
      return mapped ? registry().report(mapped, ...args) : undefined;
    },
    end: (context, ...args) => {
      const mapped = michi(context);
      return mapped ? registry().end(mapped, ...args) : undefined;
    },
  };
}
