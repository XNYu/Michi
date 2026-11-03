import { startMetaAgentMetrics, stopMetaAgentMetrics } from './services/metaAgentMetrics';
import { nextPerformanceContext, startEventLoopDiagnostics, withPerformanceContext } from './services/performanceDiagnostics';
import { jsonConfigErrorResponse } from "./routes/jsonConfigErrorResponse";
import { persistSessionState } from './services/sessionStatePersistence';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { tryForkChatSession } from './services/nativeFork';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { setupSpaFallback } from './routes/spaFallback';
import { setupMobileAccessRoutes } from './routes/mobileAccess';
import { setupSelfUpdateRoutes } from './routes/selfUpdate';
import { SelfUpdater } from './services/selfUpdate';
import { readMobileAccessChoice, saveMobileAccessChoice } from './services/mobileAccess';
import { createMobileAccess, defaultMobileAccessProvider } from './services/mobileAccessManager';
import { setupAssistantRoutes } from './routes/assistant';
import { setupMetaAgentRoutes } from './routes/metaAgent';
import { setupMetaAgentOverviewRoutes } from './routes/metaAgentOverview';
import { setupMetaAgentRunNowRoutes } from './routes/metaAgentRunNow';
import { log } from './services/logger';
import { shouldLogAccess } from './services/accessLog';
import { setupMichiRoutes } from './routes/michi';
import { setupDigestRoutes } from './routes/digests';
import { setupPersistenceRoutes } from './routes/persistence';
import { setupPaneInspectionRoutes } from './routes/paneInspection';
import { setupConversationUpdatesRoutes } from './routes/conversationUpdates';
import { setupPagesRoutes } from './routes/pages';
import { setupSpacesHomeRoutes } from './routes/spacesHome';
import { chatHubLiveWait, configureHomeLiveWait } from './services/pages/homeSections';
import { setupHomeCardsRoutes } from './routes/homeCards';
import { setupSpacesHomeRunRoutes } from './routes/spacesHomeRuns';
import { configureHomeCardsSink } from './services/metaAgent/homeCardsGenerator';
import { repositoryHomeCardsSink } from './services/metaAgent/homeCardsSink';
import { chatHubLiveTurn, configureProgressCardLiveTurns } from './services/pages/progressCards';
import { setupPageHelperRoutes } from './routes/pageHelpers';
import { setupPageComponentRoutes } from './routes/pageComponents';
import { setupPageMaintenanceRoutes } from './routes/pageMaintenance';
import { configurePaneInspectionEventBus } from './services/paneInspectionSubscribe';
import { setupBackupRoutes } from './routes/backup';
import { setupSearchRoutes } from './routes/search';
import { setupVersionRoutes } from './routes/version';
import { setupAdminRoutes } from './routes/admin';
import { setupAgentRoutes } from './routes/agent';
import { setupCustomAgentRoutes } from './routes/customAgents';
import { setupAgentRunRoutes } from './routes/agentRuns';
import { setupWorkflowRunRoutes } from './routes/workflowRuns';
import { workflowRunHub } from './services/workflowRunHub';
import { backgroundSubagentRegistry } from './services/backgroundSubagentRegistry';
import { endNodeBackgroundSubagents, endOrphanedBackgroundSubagents } from './services/backgroundSubagentEndsRepository';
import { installLocalAccessGuards } from './services/localOrigins';
import { setupUploadsRoutes } from './routes/uploads';
import { setupFilesRoutes } from './routes/files';
import { setupArtifactRoutes } from './routes/artifacts';
import { closeAllArtifactWatchers } from './services/artifactWatcher';
import { setupDiffRoutes } from './routes/diff';
import { setupBackendConnectionRoutes } from './routes/backendConnections';
import { setupHostDirectoryRoutes } from './routes/hostDirectories';
import { publicBuildInfo, runningBuild } from './services/buildInfo';
import { ChatManager } from './services/chatManager';
import { getAuthForHost, runAuthMigrations } from './services/auth';
import { resolveAccessPolicy } from './services/accessPolicy';
import { createSessionAccessMiddleware } from './routes/middleware/sessionAccess';
import { McpSlotRegistry, mountMcp } from './services/mcpServer';
import { JSON_BODY_LIMIT_BYTES } from './services/requestBodyLimit';
import { initDb, getDb, getDbPath, closeDb, closeAuditDb } from './services/db';
import { initDbWorker, shutdownDbWorker } from './services/dbWorkerClient';
import { recordAudit } from './services/audit';
import { getAgentConfig, loadAgentConfig, updateAgentConfig, reconcileRuntimeWithRegistered, resolveModel, resolveReasoning, resolveProvider } from './services/agentConfig';
import { setProviderEnvBindings, getProviderApiKey } from './services/secrets';
import { getWarmStatus, markReady, markFailed } from './services/readyState';
import { getRuntime, listRuntimes, registerRuntime } from './agents/registry';
import { findRemoteRuntimeDefault } from './services/remoteRuntimeDefault';
import { getEnabledFactories } from './agents/runtimeFactories';
import { createMichiRuntimeHost } from './agents/michiRuntimeHost';
import { agentRunToolsBindingFor } from './agents/agentRunInvocation';
import { createAgentToolBridge } from './agents/toolBridge';
import type { ProviderEnvBinding } from './agents/types';
import * as sessionRegistry from './agents/sessionRegistry';
import type { AgentRuntime } from './agents/types';
import type { KiroRuntime } from 'michi-runtime/internal/adapters/kiro/KiroRuntime';
import { printEnvInfo } from './envDetect';
import { startupMark } from './services/startupTrace';
import { configureRuntimeDeps } from './agents/runtimeDeps';
import { resolveChatPermissionMode, resolveChatApproveForMe, hasChatToolGrant, grantChatTool, chatPermissionResetToken } from './services/chatPermissions';
import { getNode, getNodeSessionBinding, listMessages, listTrees, getWorkspace, getWorkspaceInstructions, recoverInterruptedTurns, updateNodeResumeBinding, upsertAgentContextMetadata } from './services/dbRepository';
import { ensureDurableGraphNode, rollbackProvisionalSpawnNode } from './services/graphCommands';
import { getMichiDataDir } from './services/dataDir';
import {
  createRemoteAccessMiddleware,
  remoteAccessEnabled,
  remoteAccessToken,
  remoteServerId,
  resolveListenHost,
  validateRemoteAccessConfiguration,
} from './services/remoteAccess';
import { sshTunnelManager } from './services/sshTunnelManager';
import { listThreads, searchMessages, readNode, readNodeOverview } from './services/globalContext';
import { FileRuntimeCatalogCache } from './agents/runtimeModelCache';
import { refreshRuntimeModelsInBackground } from './agents/runtimeModelRefresh';
import { createAgentRunAssembly, type AgentRunAssembly } from './agents/agentRunAssembly';
import { chatHub } from './agents/chatHub';
import { configureThreadMessaging } from './agents/threadMessageTool';
import { acquireSessionRestoreLock } from './services/nativeResume';
import { AgentRunAdministrativeLifecycle } from './services/agentRunAdministrativeLifecycle';
import { createStreamTransport } from './services/streamTransport';
import { setupScheduledJobRoutes } from './routes/scheduledJobs';
import { createLocalOriginGuard, isLoopbackListenHost } from './routes/middleware/localControl';
import { ScheduledJobsRepository } from './services/scheduledJobs/repository';
import { ScheduledJobScheduler } from './services/scheduledJobs/scheduler';
import { ChatScheduledJobExecutor, isSchedulableWorkspace } from './services/scheduledJobs/chatExecutor';
import { scheduledJobEvents } from './services/scheduledJobs/events';
import { createDesktopAppLauncher } from './services/scheduledJobs/appLauncher';
import { scheduledJobsFeatureEnabled } from './services/scheduledJobs/feature';
import { configureScheduledJobTools } from './agents/scheduledJobTools';
import { CustomAgentsFeatureGate } from './services/customAgentsFeatureGate';

// Load backend/.env explicitly. The default `dotenv.config()` looks in
// process.cwd(), but in the electron + monorepo dev loop the cwd is the
// repo root, so `backend/.env` would silently be missed. Resolving from
// __dirname makes us cwd-independent.
dotenv.config({ path: path.join(__dirname, '..', '.env') });
// The desktop app forwards ~/.michi/.env into the backend it forks. The
// always-on background service is started by launchd instead, so it reads the
// same file itself (existing environment variables still win).
const SERVICE_MODE = process.env.MICHI_SERVICE_MODE === '1';
if (SERVICE_MODE) {
  dotenv.config({ path: path.join(os.homedir(), '.michi', '.env') });
}
// Reject unsupported combinations before opening databases or starting runtimes.
const accessPolicy = resolveAccessPolicy();
const REQUIRE_AUTH = accessPolicy.requireAuth;
startupMark('backend_process_start', { node: process.version, serviceMode: SERVICE_MODE });

function isDirectory(absPath: string | undefined): absPath is string {
  if (!absPath || !path.isAbsolute(absPath)) return false;
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveDefaultCwd(): string {
  const explicit = process.env.MICHI_DEFAULT_CWD;
  if (isDirectory(explicit)) return explicit;

  const launchCwd = process.env.MICHI_LAUNCH_CWD;
  if (isDirectory(launchCwd)) return launchCwd;

  const cwd = process.cwd();
  const parent = path.dirname(cwd);
  if (
    path.basename(cwd) === 'backend' &&
    fs.existsSync(path.join(parent, 'package.json')) &&
    fs.existsSync(path.join(parent, 'backend', 'package.json'))
  ) {
    return parent;
  }

  return cwd;
}

const defaultCwd = resolveDefaultCwd();
validateRemoteAccessConfiguration();

function shouldBootWarm(cwd: string): boolean {
  // Finder-launched packaged apps often inherit "/" as cwd. Warming the
  // filesystem root is wasted work; the renderer will warm the real workspace
  // once hydration discovers it.
  return path.parse(cwd).root !== cwd;
}

log.info('boot', 'backend starting', {
  pid: process.pid,
  node: process.version,
  logDir: log.logDir(),
  defaultCwd,
  processCwd: process.cwd(),
});
const app = express();
const stopEventLoopDiagnostics = startEventLoopDiagnostics();
const port = process.env.PORT || 3000;

// Initialize SQLite before anything that might need it
initDb();
if (process.env.MICHI_CLOUD !== '1') startMetaAgentMetrics();
// Spin up the async database worker thread. It opens its own WAL connection
// to the same data.db file so writes execute off the main thread. Hot-path
// routes (ensure-session) call dbWorker.* instead of synchronous dbRepository.
void initDbWorker(getDbPath()).catch((err) => {
  log.warn('boot', 'dbWorker failed to initialize; falling back to sync writes', { error: (err as Error).message });
});
// Custom Agents / Agent Runs: on only when MICHI_CUSTOM_AGENTS=1 is in the
// environment at startup. Nothing in the app can change it afterwards.
const customAgentsFeature = new CustomAgentsFeatureGate();
const pendingAgentDeliveryTurnIds = new Set((getDb().prepare(`SELECT requested_turn_id FROM agent_run_watches
    WHERE delivery_status = 'pending' AND requested_turn_id IS NOT NULL`).all() as Array<{ requested_turn_id: string }>)
  .map((row) => row.requested_turn_id));
const interruptedTurns = recoverInterruptedTurns(Date.now(), pendingAgentDeliveryTurnIds);
if (interruptedTurns > 0) {
  log.warn('boot', 'recovered interrupted turns', { count: interruptedTurns });
}
// Before any agent session starts: the background subagents stored as still
// waiting for an outcome ran in processes the previous backend owned, which
// are gone, so their outcome never comes. A failed sweep leaves them as they
// were (the renderer still reads them as interrupted once the live feed says
// no process tracks them).
try {
  const ended = endOrphanedBackgroundSubagents();
  if (ended.subagents > 0) log.info('boot', 'recorded background subagents ended by the restart', { ...ended });
} catch (error) {
  log.warn('boot', 'background subagent sweep failed', { error: (error as Error).message });
}
// A session whose process ends with background subagents still running
// records how they ended on the node's stored rosters.
backgroundSubagentRegistry.setEndRecorder((ownerUserId, nodeId, ends) => {
  const recorded = endNodeBackgroundSubagents(ownerUserId, nodeId, ends);
  return recorded ? { workspaceId: recorded.workspaceId } : null;
});
log.info('boot', 'db initialized');

// Load persisted agent runtime/provider/model config (with env overrides)
loadAgentConfig();
log.info('boot', 'agent config loaded');

// Wire Michi's SQLite / secrets / config into the runtime layer's injection
// seam. MUST run before any runtime is constructed or warmed, since the
// runtime modules read getRuntimeDeps() at call-time and throw if unconfigured.
configureRuntimeDeps({
  onSessionStateChanged: persistSessionState,
  chatPermissions: { getMode: resolveChatPermissionMode, getApproveForMe: resolveChatApproveForMe, hasGrant: hasChatToolGrant, grant: grantChatTool, resetToken: chatPermissionResetToken },
  historyStore: { getNode, listMessages, getWorkspace, getWorkspaceInstructions },
  dataDir: getMichiDataDir(),
  providerKeys: { getProviderApiKey },
  globalContext: { listThreads, searchMessages, readNode, readNodeOverview },
  agentConfig: { getAgentConfig, resolveModel, resolveReasoning },
});

const mcpRegistry = new McpSlotRegistry({ mcpPort: Number(port) });
const runtimeModelCache = new FileRuntimeCatalogCache(getMichiDataDir());
// One host for every runtime: the adapters read Michi through its ports.
const runtimeHost = createMichiRuntimeHost();
// Before the first runtime registers: the manager reads session ownership from this host.
sessionRegistry.configureRuntimeManager(runtimeHost);

// Register the enabled runtimes (filtered by MICHI_ENABLED_RUNTIMES, or
// all of them locally) through a single factory loop. Each factory
// creates its runtime with a bridge whose createChild calls
// runtime.newSession and registers the child in sessionRegistry. Provider
// env bindings are collected here and pushed into secrets.ts after
// registration.
const allEnvBindings: ProviderEnvBinding[] = [];
let kiroRuntime: KiroRuntime | undefined;
let agentRunAssembly: AgentRunAssembly | null = null;
for (const factory of getEnabledFactories()) {
    let runtime!: AgentRuntime;
    const bridge = createAgentToolBridge({
        createChild: async (args) => {
            const parentBinding = getNodeSessionBinding(args.parentChatId, args.ownerUserId ?? undefined);
            const parentNode = parentBinding
              ? getNode(parentBinding.nodeId)
              : process.env.MICHI_CLOUD === '1'
                ? null
                : getNode(args.parentChatId);
            if (!parentNode) throw new Error(`spawn parent node not found for ${args.parentChatId}`);
            const workspace = getWorkspace(parentNode.workspace_id);
            if (!workspace) throw new Error(`spawn workspace ${parentNode.workspace_id} not found`);
            const tree = parentNode.tree_id
              ? listTrees(parentNode.workspace_id).find((candidate) => candidate.id === parentNode.tree_id)
              : undefined;
            const nodeId = `n-${randomUUID()}`;
            ensureDurableGraphNode({
              workspace: {
                id: workspace.id,
                name: workspace.name,
                cwd: workspace.cwd ?? null,
                createdAt: workspace.created_at,
                activeTreeId: workspace.active_tree_id ?? parentNode.tree_id ?? null,
              },
              ...(tree ? {
                tree: {
                  id: tree.id,
                  rootNodeId: tree.root_node_id,
                  name: tree.name ?? null,
                  archivedAt: tree.archived_at ?? null,
                  pinnedAt: tree.pinned_at ?? null,
                  lastActiveAt: tree.last_active_at,
                  createdAt: tree.created_at,
                },
              } : {}),
              node: {
                id: nodeId,
                treeId: parentNode.tree_id ?? null,
                parentNodeId: parentNode.id,
                kind: 'chat',
                title: args.title,
                spawnedByAgent: true,
                // A tiny durable outbox. It lets hydration restart the child
                // even when the parent spawn SSE frame expired from the ring.
                composerDraft: JSON.stringify({ __michiPendingSpawnPrompt: args.prompt }),
                createdAt: Date.now(),
              },
              edges: [{
                id: `branch-${parentNode.id}-${nodeId}`,
                sourceNodeId: parentNode.id,
                targetNodeId: nodeId,
                kind: 'branch',
                createdAt: Date.now(),
              }],
              ownerUserId: workspace.owner_user_id ?? null,
            });
            let child: Awaited<ReturnType<AgentRuntime['newSession']>> | undefined;
            const userId = process.env.MICHI_CLOUD === '1' ? workspace.owner_user_id ?? undefined : undefined;
            const model = resolveModel(runtime.id, userId);
            const provider = resolveProvider(runtime.id, userId);
            const reasoning = resolveReasoning(runtime.id, userId);
            try {
                const sessionOptions = {
                    cwd: args.cwd,
                    parentChatId: args.parentChatId,
                    enableFollowUps: args.enableFollowUps,
                    sessionId: nodeId,
                    workspaceId: parentNode.workspace_id,
                    ownerUserId: workspace.owner_user_id ?? null,
                    model, provider, reasoning,
                };
                child = await tryForkChatSession(runtime, sessionOptions) ?? await runtime.newSession(sessionOptions);
                updateNodeResumeBinding(nodeId, {
                  acp_session_id: child.nativeSessionId ?? child.id,
                  runtime_id: child.runtimeId,
                  runtime_engine: child.nativeEngine ?? null,
                  provider_id: provider,
                  model_id: child.currentModelId ?? model,
                  reasoning,
                  current_mode_id: child.currentModeId ?? null,
                });
                sessionRegistry.registerSession(child, workspace.owner_user_id ?? null);
            } catch (err) {
                if (child) {
                  await runtime.releaseSession(child.id);
                  sessionRegistry.dropSession(child.id);
                }
                rollbackProvisionalSpawnNode(
                  nodeId,
                  parentNode.workspace_id,
                  workspace.owner_user_id ?? null,
                );
                throw err;
            }
            return { chatId: child.id, nodeId };
        },
        persistContext: ({ chatId, ownerUserId, name, filePath, size }) => {
            const userId = ownerUserId ?? undefined;
            const binding = getNodeSessionBinding(chatId, userId);
            if (!binding) {
                log.warn('bridge', 'context metadata skipped (chat has no durable binding)', { chatId, name });
                return false;
            }
            return upsertAgentContextMetadata({
                workspaceId: binding.workspaceId,
                nodeId: binding.nodeId,
                name,
                filePath,
                size,
                userId,
            });
        },
        agentRunToolsForSession: (binding) => {
            // Null while Custom Agents is off, so ordinary chats are not handed
            // spawn_agent & co. at all.
            if (!agentRunAssembly) return null;
            const caller = agentRunToolsBindingFor(binding);
            return caller ? agentRunAssembly.toolInvokerForSession(caller) : null;
        },
    });
    runtime = factory.create({
      bridge,
      mcpRegistry,
      mcpPort: Number(port),
      defaultCwd,
      modelCache: runtimeModelCache,
      host: runtimeHost,
    });
    registerRuntime(runtime);
    if (factory.id === 'kiro') kiroRuntime = runtime as KiroRuntime;
    if (factory.envBindings) allEnvBindings.push(...factory.envBindings);
    log.info('boot', 'runtime registered', { id: runtime.id });
}
setProviderEnvBindings(allEnvBindings);
reconcileRuntimeWithRegistered(listRuntimes().map((r) => r.id));

// kiroRuntime may be undefined in Pi-only / Claude-only deployments;
// ChatManager guards its Kiro-specific methods accordingly.
const chatManager = new ChatManager(kiroRuntime, defaultCwd);
configureThreadMessaging({
  ensureSession: (input) => chatManager.ensureParentSession(input),
  startTurn: (args) => chatHub.startRequestedSelfTurn(args),
  acquireRestoreLock: acquireSessionRestoreLock,
  newTurnId: () => randomUUID(),
  startWaitMs: 3_000,
});
agentRunAssembly = createAgentRunAssembly({
  isEnabled: () => customAgentsFeature.isEnabled(),
  chatManager,
  defaultCwd,
  dataDir: getMichiDataDir(),
});

const agentRunLifecycle = new AgentRunAdministrativeLifecycle({
  quiesceRun: async (ownerUserId, runId) => {
    await agentRunAssembly!.coordinator.quiesceForAdministrativeDeletion(ownerUserId, runId);
  },
  cleanupRun: async (runId, resources) => {
    const cleaner = agentRunAssembly!.resourceCleaner;
    if (!cleaner.cleanupResources) {
      throw new Error('Agent Run resource cleaner cannot clean captured resources');
    }
    await cleaner.cleanupResources(runId, resources);
  },
  auditCleanupFailure: ({ ownerUserId, runId, message }) => {
    log.warn('boot', 'Agent Run administrative cleanup will retry', { ownerUserId, runId, message });
  },
});

let agentRunCleanupPass: Promise<void> | null = null;
const retryAgentRunCleanup = (): void => {
  if (agentRunCleanupPass) return;
  agentRunCleanupPass = agentRunLifecycle.retryPendingCleanup().then((result) => {
    if (result.cleanedRunIds.length || result.failed.length) {
      log.info('boot', 'Agent Run administrative cleanup pass complete', {
        cleaned: result.cleanedRunIds.length,
        failed: result.failed.length,
      });
    }
  }).catch((error) => {
    log.warn('boot', 'Agent Run administrative cleanup pass failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }).finally(() => {
    agentRunCleanupPass = null;
  });
};
retryAgentRunCleanup();
const agentRunCleanupTimer = setInterval(retryAgentRunCleanup, 60_000);
agentRunCleanupTimer.unref();

const agentRunRecoveryPromise = agentRunAssembly.start()
  .then((summary) => {
    if (customAgentsFeature.isEnabled()) {
      agentRunAssembly!.completeFeatureEnable();
      log.info('boot', 'Agent Run recovery audit complete', { ...summary });
    }
    const remaining = recoverInterruptedTurns(Date.now(), new Set([
      ...chatHub.activeDurableTurnIds(),
      ...pendingAgentDeliveryTurnIds,
    ]));
    if (remaining > 0) log.warn('boot', 'recovered deferred interrupted turns', { count: remaining });
    return summary;
  });

// The Meta agent chat window checks its tools inside each turn on some runtimes.

// Scheduled Jobs run prompts headlessly as ordinary durable chat turns. They
// are a desktop feature: cloud deployments have per-user owners and no local
// notification path, so the scheduler stays off there.
const SCHEDULED_JOBS_ENABLED = scheduledJobsFeatureEnabled();
const scheduledJobExecutor = SCHEDULED_JOBS_ENABLED
  ? new ChatScheduledJobExecutor({
      chatHub,
      ensureSession: (input) => chatManager.ensureParentSession(input),
      releaseMaintenanceSession: (input) => chatManager.releaseMaintenanceSession(input),
    })
  : null;
const scheduledJobScheduler = scheduledJobExecutor
  ? new ScheduledJobScheduler({
      repository: new ScheduledJobsRepository(),
      executor: scheduledJobExecutor,
      events: scheduledJobEvents,
      // A hidden system workspace (the Michi assistant's) is not a place a
      // job may run in: to the scheduler it does not exist.
      workspaceExists: (id) => isSchedulableWorkspace(getWorkspace(id)),
      runtimeExists: (id) => !!getRuntime(id),
      launcher: createDesktopAppLauncher(),
      serviceMode: SERVICE_MODE,
    })
  : null;
configureScheduledJobTools(scheduledJobScheduler && scheduledJobExecutor
  ? {
      scheduler: scheduledJobScheduler,
      isScheduledRunNode: (nodeId) => scheduledJobExecutor.isRunningOn(nodeId),
      workspaceName: (id) => getWorkspace(id)?.name ?? null,
    }
  : null);
// Resolved once the HTTP listener is bound (see app.listen below).
let markListening!: () => void;
const listeningPromise = new Promise<void>((resolve) => { markListening = resolve; });
// Start after interrupted-turn recovery so a run never races boot repair, and
// only once this process is reachable: a backend that failed to bind must not
// hold the scheduler lease and run jobs no window can see.
void Promise.all([agentRunRecoveryPromise.catch(() => undefined), listeningPromise])
  .then(() => {
    scheduledJobScheduler?.start();
    if (scheduledJobScheduler) log.info('boot', 'scheduled jobs started', { serviceMode: SERVICE_MODE });
  });

async function warmConfiguredRuntime(): Promise<void> {
  if (remoteAccessEnabled()) {
    const selected = await findRemoteRuntimeDefault(listRuntimes(), getAgentConfig().runtime);
    if (!selected) {
      log.info('boot', 'remote machine ready; no configured runtime to warm');
      return;
    }
    if (selected.id !== getAgentConfig().runtime) updateAgentConfig({ runtime: selected.id });
  }
  if (!shouldBootWarm(defaultCwd)) {
    log.info('boot', 'warm skipped', { defaultCwd, reason: 'filesystem_root' });
    startupMark('chat_warm_skipped', { defaultCwd, reason: 'filesystem_root' });
    return;
  }
  const cfg = getAgentConfig();
  const runtime = getRuntime(cfg.runtime);
  if (!runtime?.capabilities.warmSessions) return;
  await runtime.warm(defaultCwd, { model: resolveModel(cfg.runtime) });
}

// Fire warm BEFORE app.listen so the active runtime spawn overlaps express
// setup, route mounting, and (in cloud mode) auth middleware
// initialization. Must remain after setProviderEnvBindings (above)
// because Pi/Claude warm hooks read provider env.
const tWarm = Date.now();
startupMark('chat_warm_start');
const warmPromise = Promise.all([warmConfiguredRuntime(), agentRunRecoveryPromise])
  .then(() => {
    log.info('boot', 'warm complete', { durMs: Date.now() - tWarm });
    startupMark('chat_warm_done', { durMs: Date.now() - tWarm });
    markReady();
  })
  .catch((err: Error) => {
    log.warn('boot', 'warm failed (will retry on first request)', { err: err.message });
    startupMark('chat_warm_failed', { durMs: Date.now() - tWarm, error: err.message });
    markFailed(err);
  });
// Suppress unhandled-rejection: state is captured via markFailed.
warmPromise.catch(() => {});

// Dynamic catalogs use stale-while-revalidate: runtime constructors load the
// previous disk snapshot synchronously, while this refresh asks each CLI for
// the current catalog without delaying Express readiness.
refreshRuntimeModelsInBackground(listRuntimes().filter(runtime => runtime.id === getAgentConfig().runtime), (runtimeId, err) => {
  log.warn('boot', 'runtime model refresh failed; using cached catalog', {
    runtimeId,
    err: err.message,
  });
});

// Session auth supports isolated cloud hosting and explicitly selected local
// single-account access. Desktop/dev keep their origin-protected local mode:
// no session middleware and no /api/auth/* handler; origin and host guards
// keep other web pages out (services/localOrigins.ts).

if (REQUIRE_AUTH) {
  // CORS — credentials:true is required so the browser sends the auth
  // cookie cross-origin (frontend dev server runs on :3001, backend on
  // :3000). origin must echo the request origin (not '*') for
  // credentialed CORS to be allowed.
  const ALLOWED_ORIGINS = (process.env.MICHI_CORS_ORIGINS || 'http://localhost:3001,http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  // Better-Auth handler must be mounted BEFORE express.json() — its
  // internal node-handler reads the raw request stream itself, and a
  // pre-parsed body breaks the OAuth callback's form post.
  // Routes covered: /api/auth/sign-in/social, /sign-out, /get-session,
  // /callback/google, etc.
  //
  // Per-host dispatch: getAuthForHost(req.headers.host) returns the Auth
  // instance whose baseURL matches the incoming origin. This lets the
  // same service serve multiple domains (e.g. a custom domain plus the
  // Railway-default fallback) where OAuth callbacks must round-trip back
  // to the originating host. Each instance owns its own cookies, so
  // sessions don't leak across origins; users are still unified at the
  // DB layer.
  //
  // We rebuild the toNodeHandler wrapper per request rather than caching
  // it — toNodeHandler is cheap, and caching one per host doesn't save
  // anything because the Auth instance itself is already cached.
  //
  // Auth event recording: after the auth handler responds we inspect the
  // URL path + status to emit an audit record. We use res.on('finish')
  // to observe the final status code without interfering with the stream.
  app.all('/api/auth/*splat', (req, res) => {
    const inst = getAuthForHost(req.headers.host);
    const ip = ((req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()) ?? req.ip ?? null;
    const ua = (req.headers['user-agent'] as string | undefined) ?? null;
    res.on('finish', () => {
      const status = res.statusCode;
      const urlPath = req.path; // e.g. /api/auth/sign-in/social
      // Derive actor: better-auth attaches user after sign-in; may be null for failures
      const actor = req.user ? { id: req.user.id, email: req.user.email } : null;
      if (req.method === 'POST' && urlPath.includes('/sign-in/')) {
        if (status < 400) {
          recordAudit({ action: 'auth.sign_in.success', actor, ip, ua });
        } else {
          recordAudit({ action: 'auth.sign_in.failure', actor: null, ip, ua });
        }
      } else if (req.method === 'POST' && urlPath.includes('/sign-out') && status < 400) {
        recordAudit({ action: 'auth.sign_out', actor, ip, ua });
      } else if (urlPath.includes('/callback/') && status < 400) {
        // OAuth callback completes the sign-in; also record sign_up for new users.
        // We can't distinguish new vs returning here without a DB lookup — omit
        // duplicate sign_in.success (the /sign-in route already recorded it).
        // Record sign_up via a session check post-callback if user createdAt is recent.
        try {
          getAuthForHost(req.headers.host).api.getSession({ headers: fromNodeHeaders(req.headers) })
            .then((session: any) => {
              if (session?.user) {
                const createdTs = session.user.createdAt
                  ? new Date(session.user.createdAt).getTime()
                  : 0;
                if (Date.now() - createdTs < 30_000) {
                  // Created within the last 30 s — this is a sign_up
                  recordAudit({
                    action: 'auth.sign_up',
                    actor: { id: session.user.id, email: session.user.email },
                    ip,
                    ua,
                  });
                }
              }
            })
            .catch(() => { /* best-effort */ });
        } catch { /* best-effort */ }
      }
    });
    return toNodeHandler(inst)(req, res);
  });
} else {
  // Desktop/dev: the API has no user sessions, so the origin and host decide
  // which pages may use it. One rule (services/localOrigins.ts) serves CORS,
  // this guard stack and the /api guard below: Michi's own UI (same origin),
  // the dev renderers (MICHI_DEV_RENDERER, MICHI_RENDERER_URL) and configured
  // origins (MICHI_CORS_ORIGINS, MICHI_LOCAL_CONTROL_ORIGINS). Other sites get
  // no CORS headers, and any request they send is refused before a route runs
  // (CORS alone would still run a simple POST's handler). A wildcard here
  // would let any web page read this API while Michi is running — and with
  // the background service, Michi is always running. Without remote access's
  // token, a DNS name that is not loopback or listed is DNS rebinding.
  installLocalAccessGuards(app, { remoteAccess: remoteAccessEnabled() });
  log.info('auth', 'MICHI_REQUIRE_AUTH not set — auth middleware disabled');
}

app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));

// A server explicitly launched for remote control is protected by a shared
// bearer token. Desktop/dev remain unchanged unless MICHI_REMOTE_ACCESS=1.
app.use('/api', createRemoteAccessMiddleware());

if (!REQUIRE_AUTH) {
  // Behind installLocalAccessGuards and with the same origin and host rules,
  // also reject cross-site browser requests that carry no Origin before any
  // /api route runs. Token-authenticated remote requests are exempt.
  app.use('/api', createLocalOriginGuard({ loopbackListener: isLoopbackListenHost(resolveListenHost()) }));
}

if (REQUIRE_AUTH) {
  // Every protected /api/* path needs a valid session. The shared gate attaches
  // req.authUser and req.session; only cloud mode also sets req.user as the data
  // owner. Authenticated desktop requests retain the local data identity.
  //
  // IMPORTANT: when this middleware is mounted under app.use('/api', ...),
  // Express strips the '/api' prefix from req.path inside the handler,
  // so match against the post-strip path: '/health' and '/auth/...'.
  app.use('/api', createSessionAccessMiddleware(accessPolicy,
    req => getAuthForHost(req.headers.host).api.getSession({ headers: fromNodeHeaders(req.headers) }),
    err => log.warn('auth', 'getSession failed', { err: (err as Error).message }),
  ));
}

// Single-line access log per request — first signal that the frontend
// actually reached the backend, and useful when chasing 4xx/5xx in the
// field. SSE routes log just the request kickoff (status fires after
// `res.end()` regardless).
const ACCESS_LOG_SILENT_2XX = [
  /^(?:\/api)?\/health$/,                    // health checks
  /^(?:\/api)?\/ready$/,                     // cold-start readiness poll (250ms until warm)
  /^(?:\/api)?\/agent\/status$/,             // runtime capability probe
  /^(?:\/api)?\/agent\/models$/,             // model picker / sanitized-model probe
  /^(?:\/api)?\/mcp\/[^/]+$/,                // MCP slot calls (per-turn, very noisy)
  /^(?:\/api)?\/mcp-session\/[^/]+$/,        // MCP session-group calls (Kiro's shared catalog)
  /^(?:\/api)?\/nodes\/[^/]+\/ensure-session$/, // lazy session binding before send
  /^(?:\/api)?\/workspaces$/,                // lightweight workspace index load
  /^(?:\/api)?\/workspaces\/all$/,           // full workspace hydration
  /^(?:\/api)?\/workspaces\/[^/]+\/sync$/,   // bulk chat sync (frequent client poll)
  /^(?:\/api)?\/chats\/[^/]+\/heartbeat$/,   // compatibility heartbeat from older renderers
];
// MCP slot and group ids in a path are capabilities: log only their first 4 hex chars.
const redactCapabilityIds = (path: string) =>
  path.replace(/(?<=\/)[0-9a-f]{32}(?=\/|$)/g, (id) => `${id.slice(0, 4)}…`);
app.use((req, res, next) => {
  const t0 = Date.now();
  const requestId = nextPerformanceContext();
  res.on('finish', () => {
    const dur = Date.now() - t0;
    const status = res.statusCode;
    if (!shouldLogAccess(req.method, req.path, status)) return;
    const stage = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    const fn = stage === 'error' ? log.error : stage === 'warn' ? log.warn : log.info;
    fn('http', `${req.method} ${redactCapabilityIds(req.path)}`, { status, durMs: dur, requestId });
  });
  withPerformanceContext(requestId, next);
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'michi-backend',
    connectionProtocol: 1,
    build: publicBuildInfo(runningBuild),
    serverId: remoteServerId(),
    // Lets the desktop app tell its background service apart from a forked
    // child and restart the service after an app update.
    serviceMode: SERVICE_MODE,
    serviceBuild: SERVICE_MODE ? process.env.MICHI_SERVICE_BUILD ?? null : null,
  });
});

// Auth-config probe — frontend hits this on boot to decide whether to
// gate the UI behind a sign-in flow. Public (no session required) so the
// landing page can render before the user has a cookie.
app.get('/api/auth-config', (_req, res) => {
  res.json({ requireAuth: REQUIRE_AUTH });
});

// Diagnostics — exposes log paths so the user can find logs without
// guessing. Frontend's settings/help can show these and a "Open log
// folder" button (Electron preload bridges shell.showItemInFolder).
app.get('/api/diagnostics', (_req, res) => {
  res.json({
    logDir: log.logDir(),
    backendLog: log.backendLogPath(),
    kiroCliLog: log.kiroCliLogPath(),
    pid: process.pid,
    nodeVersion: process.version,
  });
});

// Boot readiness probe — frontend polls this on cold-start instead of
// paying the exponential backoff on /agent/status. Public (no session
// required) so the landing page can render before sign-in. The handler
// MUST NOT call into AgentRuntime methods — it reads only the
// readyState module variable so it stays sub-millisecond regardless
// of how slow warm() is taking.
app.get('/api/ready', (_req, res) => {
  res.json(getWarmStatus());
});

const mcpRouter = express.Router();
const streamTransport = createStreamTransport();
app.use('/api', streamTransport.router);
mountMcp(mcpRouter, mcpRegistry);
app.use('/api', mcpRouter);

const customAgentsControl = {
  isEnabled: () => customAgentsFeature.isEnabled(),
};
app.use('/api', setupAgentRoutes({ catalogCache: runtimeModelCache, customAgents: customAgentsControl }));
app.use('/api', setupCustomAgentRoutes({
  service: agentRunAssembly.definitionService,
  isEnabled: customAgentsControl.isEnabled,
}));
app.use('/api', setupAgentRunRoutes({
  service: agentRunAssembly.routeService,
  sse: agentRunAssembly.sse,
  isEnabled: customAgentsControl.isEnabled,
}));
// Workflow runs are independent of custom agents: any Claude/Kiro chat can
// launch one.
// Runs a previous process left open lost their runtime with it.
workflowRunHub.recover();
app.use('/api', setupWorkflowRunRoutes({ hub: workflowRunHub, backgroundSubagents: backgroundSubagentRegistry }));
const mobileAccessChoice = path.join(getMichiDataDir(), 'mobile-access.json');
const mobileAccess = createMobileAccess({
  target: () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Michi is not listening yet');
    const host = address.address === '::1' || address.address === '::' ? '[::1]' : '127.0.0.1';
    return `http://${host}:${address.port}`;
  },
  token: () => remoteAccessEnabled() ? remoteAccessToken() : null,
  unavailableReason: () => REQUIRE_AUTH || process.env.MICHI_CLOUD === '1'
    ? 'Mobile tunnels are available on personal Michi backends.'
    : !servingFrontend
      ? 'Build the web UI with npm run build, then restart this backend before enabling phone access.' : null,
});
// The choice belongs to this personal backend, including the desktop host.
app.use('/api', setupMobileAccessRoutes(mobileAccess, {
  remember: (enabled, provider) => {
    try { saveMobileAccessChoice(mobileAccessChoice, enabled, provider); }
    catch (error) { log.warn('http', 'could not save phone access choice', { error: (error as Error).message }); }
  },
}));
// Settings → Update: a remote backend replaces itself with the latest main branch.
// Elsewhere the status explains why it cannot, and nothing runs.
app.use('/api', setupSelfUpdateRoutes(new SelfUpdater({
  repoRoot: path.resolve(__dirname, '../..'),
  dataDir: getMichiDataDir(),
  current: publicBuildInfo(runningBuild),
  remoteAccess: remoteAccessEnabled() && !REQUIRE_AUTH && process.env.MICHI_CLOUD !== '1',
})));
// Saved credentials belong to the desktop gateway, not execution backends.
if (!remoteAccessEnabled()) {
  app.use('/api', setupBackendConnectionRoutes());
} else if (process.env.MICHI_CLOUD !== '1') {
  // The desktop that connects to this remote browses its folders through the
  // tunnel. Requests reaching it already passed the bearer-token middleware.
  app.use('/api', setupHostDirectoryRoutes());
}
if (REQUIRE_AUTH) {
  // Admin routes — gated by MICHI_ADMIN_EMAILS env var (requireAdmin).
  // requireSession is already applied globally above for all /api/* paths
  // not in SESSION_PUBLIC_PATHS, so the login principal is populated here.
  app.use('/api/admin', setupAdminRoutes({ agentRunLifecycle }));
}
app.use('/api', setupUploadsRoutes());
app.use('/api', setupFilesRoutes());
app.use('/api', setupArtifactRoutes());
app.use('/api', setupDiffRoutes());
app.use('/api', setupMichiRoutes(chatManager));
app.use('/api', setupDigestRoutes(chatManager));
app.use('/api', setupPersistenceRoutes());
configurePaneInspectionEventBus(agentRunAssembly.enabled ? agentRunAssembly.coordinator.events : undefined);
app.use('/api', setupPaneInspectionRoutes({ agentRunEvents: agentRunAssembly.enabled ? agentRunAssembly.coordinator.events : undefined }));
app.use('/api', setupConversationUpdatesRoutes());
app.use('/api', setupPagesRoutes());
app.use('/api', setupSpacesHomeRoutes({ liveWait: (nodeId) => chatHubLiveWait(chatHub, nodeId) }));
app.use('/api', setupHomeCardsRoutes());
app.use('/api', setupPageHelperRoutes());
app.use('/api', setupPageComponentRoutes());
configureHomeCardsSink(repositoryHomeCardsSink);
configureProgressCardLiveTurns((nodeId) => chatHubLiveTurn(chatHub, nodeId));
configureHomeLiveWait((nodeId) => chatHubLiveWait(chatHub, nodeId));
app.use('/api', setupSpacesHomeRunRoutes({ scheduler: scheduledJobScheduler }));
// Before the local-only /meta-agent routes: a remote connection's Update reaches its own Meta agent.
app.use('/api', setupMetaAgentRunNowRoutes({ scheduler: scheduledJobScheduler }));
app.use('/api', setupPageMaintenanceRoutes({ scheduler: scheduledJobScheduler }));
app.use('/api', setupBackupRoutes());
app.use('/api', setupSearchRoutes());
app.use('/api', setupVersionRoutes());
// Assistant and Meta agent controls belong to this backend's owner,
// including authenticated remote access. Cloud owners remain isolated.
if (process.env.MICHI_CLOUD !== '1') {
  app.use('/api', setupAssistantRoutes());
  app.use('/api', setupMetaAgentRoutes());
  app.use('/api', setupMetaAgentOverviewRoutes({ scheduler: scheduledJobScheduler }));
}
app.use('/api', setupScheduledJobRoutes({ scheduler: scheduledJobScheduler, events: scheduledJobEvents }));

const frontendBuild = path.join(__dirname, '../../frontend/build');
const indexHtml = path.join(frontendBuild, 'index.html');

const servingFrontend = fs.existsSync(indexHtml);
if (servingFrontend) {
  setupSpaFallback(app, frontendBuild);
}

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) { next(err); return; }
  const configError = jsonConfigErrorResponse(err);
  if (configError) {
    log.error('http', 'configuration request failed', { path: req.path, code: configError.body.code, err: err.message });
    res.status(configError.status).json(configError.body);
    return;
  }
  log.error('http', 'unhandled error', { path: req.path, err: err.message, stack: err.stack });
  res.status(500).json({ error: 'Something broke!' });
});

const listenHost = resolveListenHost();
startupMark('express_listen_start', { port: Number(port), host: listenHost });
const server = app.listen(Number(port), listenHost, (error?: Error) => {
  if (error) {
    // Express 5 hands bind errors (e.g. EADDRINUSE) to this callback instead
    // of throwing. Without a listener the process would keep its runtimes
    // running while every request goes to whoever holds the port, so exit.
    const code = (error as NodeJS.ErrnoException).code;
    log.error('boot', 'listen failed; exiting', {
      port: Number(port),
      host: listenHost,
      code,
      err: code === 'EADDRINUSE' ? `port ${port} is already in use on ${listenHost}` : error.message,
    });
    void gracefulShutdown().finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 5000).unref();
    return;
  }
  log.info('boot', 'listening', { port: Number(port), host: listenHost });
  markListening();
  if (process.env.MICHI_MOBILE_ACCESS === '1' || readMobileAccessChoice(mobileAccessChoice, defaultMobileAccessProvider())) void mobileAccess.start().catch(error => log.warn('boot', 'mobile access start failed', { error: (error as Error).message }));
  startupMark('express_listen_ready', { port: Number(port) });
  printEnvInfo(Number(port));

  // Auth schema migration — idempotent, runs only when MICHI_REQUIRE_AUTH
  // is set so dev/Electron mode never touches auth.sqlite. Fire-and-forget
  // because the very first /api/auth/* request will fail until tables
  // exist anyway, and we don't want migration errors to block listening.
  if (REQUIRE_AUTH) {
    const tMig = Date.now();
    runAuthMigrations().then(() => {
      log.info('auth', 'migrations applied', { durMs: Date.now() - tMig });
    }).catch((err) => {
      log.error('auth', 'migrations failed', { err: (err as Error).message });
    });
  }
});

streamTransport.attach(server);

let shuttingDown = false;
const gracefulShutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopEventLoopDiagnostics();
  log.info('boot', 'shutting down');
  chatHub.prepareForShutdown();
  streamTransport.close();
  clearInterval(agentRunCleanupTimer);
  await agentRunCleanupPass;
  // Record in-flight scheduled runs as interrupted while the DB is open.
  await scheduledJobScheduler?.stop().catch(() => {});
  scheduledJobExecutor?.dispose();
  await agentRunAssembly?.shutdown();
  sessionRegistry.clearAllSessions();
  // runtime.shutdown() disposes each session, which SIGTERM/SIGKILLs the
  // underlying claude/kiro child. Skipping this orphans those children: they
  // keep POSTing to /api/mcp/:slotId on the old port and the next backend
  // instance 404s them ("unknown mcp slot").
  await Promise.allSettled(listRuntimes().map((runtime) => runtime.shutdown()));
  await mobileAccess.stop();
  sshTunnelManager.shutdown();
  closeAllArtifactWatchers();
  // Coalesced workflow snapshots would otherwise lose their last revisions.
  workflowRunHub.flush();
  await stopMetaAgentMetrics();
  closeDb();
  closeAuditDb();
  await shutdownDbWorker();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // server.close() only stops accepting new connections; it then WAITS for
    // every in-flight connection to drain. An ACP subprocess (kiro-cli) holds a
    // persistent keep-alive connection to /api/mcp/:slotId that never closes on
    // its own, so close() would hang indefinitely (its callback never fires) —
    // which is exactly what left orphaned backend + kiro-cli processes holding
    // the port on every dev restart. Force those sockets shut so close()
    // completes. runtime.shutdown() above has already signalled the children.
    server.closeAllConnections();
  });
};

// SIGINT/SIGTERM → terminate (Ctrl-C, container stop, Railway redeploy).
const shutdownAndExit = () => {
  void gracefulShutdown().finally(() => {
    log.info('boot', 'server closed; exiting');
    process.exit(0);
  });
  // Watchdog: never hang forever on a stuck server.close() or child.
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGINT', shutdownAndExit);
process.on('SIGTERM', shutdownAndExit);

// SIGUSR2 → nodemon's dev-restart signal. Node's default action for an
// unhandled SIGUSR2 is to terminate immediately, which orphaned the claude
// children on every code save. Clean up first, then re-raise SIGUSR2 so
// nodemon performs the actual restart. `once` so the re-raised signal falls
// through to the default action instead of looping back into this handler.
if (process.platform !== 'win32') {
  process.once('SIGUSR2', () => {
    void gracefulShutdown().finally(() => {
      process.kill(process.pid, 'SIGUSR2');
    });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
