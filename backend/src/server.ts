import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { log } from './services/logger';
import { setupMichiRoutes } from './routes/michi';
import { setupDigestRoutes } from './routes/digests';
import { setupPersistenceRoutes } from './routes/persistence';
import { setupPaneInspectionRoutes } from './routes/paneInspection';
import { setupBackupRoutes } from './routes/backup';
import { setupSearchRoutes } from './routes/search';
import { setupVersionRoutes } from './routes/version';
import { setupAdminRoutes } from './routes/admin';
import { setupAgentRoutes } from './routes/agent';
import { setupCustomAgentRoutes } from './routes/customAgents';
import { setupAgentRunRoutes } from './routes/agentRuns';
import { setupUserKeysRoutes } from './routes/userKeys';
import { setupUploadsRoutes } from './routes/uploads';
import { setupFilesRoutes } from './routes/files';
import { setupArtifactRoutes } from './routes/artifacts';
import { closeAllArtifactWatchers } from './services/artifactWatcher';
import { setupDiffRoutes } from './routes/diff';
import { setupBackendConnectionRoutes } from './routes/backendConnections';
import { ChatManager } from './services/chatManager';
import { getAuth, getAuthForHost, runAuthMigrations } from './services/auth';
import { requireAdmin } from './routes/middleware/admin';
import { McpSlotRegistry, mountMcp } from './services/mcpServer';
import { initDb, getDb, getDbPath, closeDb, closeAuditDb } from './services/db';
import { initDbWorker, shutdownDbWorker } from './services/dbWorkerClient';
import { recordAudit } from './services/audit';
import { getAgentConfig, loadAgentConfig, reconcileRuntimeWithRegistered, resolveModel, resolveReasoning, resolveProvider } from './services/agentConfig';
import { setProviderEnvBindings, getProviderApiKey } from './services/secrets';
import { getWarmStatus, markReady, markFailed } from './services/readyState';
import { getRuntime, listRuntimes, registerRuntime } from './agents/registry';
import { getEnabledFactories } from './agents/runtimeFactories';
import { createAgentToolBridge } from './agents/toolBridge';
import type { ProviderEnvBinding } from './agents/types';
import * as sessionRegistry from './agents/sessionRegistry';
import type { AgentRuntime } from './agents/types';
import type { KiroRuntime } from './agents/kiro/KiroRuntime';
import { printEnvInfo } from './envDetect';
import { startupMark } from './services/startupTrace';
import { configureRuntimeDeps } from './agents/runtimeDeps';
import { getNode, getNodeSessionBinding, listMessages, listTrees, getWorkspace, getWorkspaceInstructions, hasGrant, grantPermission, recoverInterruptedTurns, updateNodeResumeBinding, upsertAgentContextMetadata } from './services/dbRepository';
import { ensureDurableGraphNode, rollbackProvisionalSpawnNode } from './services/graphCommands';
import { getMichiDataDir } from './services/dataDir';
import {
  createRemoteAccessMiddleware,
  remoteAccessEnabled,
  remoteServerId,
  resolveListenHost,
  validateRemoteAccessConfiguration,
} from './services/remoteAccess';
import { sshTunnelManager } from './services/sshTunnelManager';
import { listThreads, searchMessages, readNode, readNodeOverview } from './services/globalContext';
import { FileRuntimeCatalogCache } from './agents/runtimeModelCache';
import { refreshRuntimeModelsInBackground } from './agents/runtimeModelRefresh';
import { createAgentRunAssembly, type AgentRunAssembly } from './agents/agentRunAssembly';
import { LOCAL_AGENT_OWNER_ID } from './services/agentOwner';
import { chatHub } from './agents/chatHub';
import { AgentRunAdministrativeLifecycle } from './services/agentRunAdministrativeLifecycle';
import { createStreamTransport } from './services/streamTransport';

import { CustomAgentsFeatureBusyError, CustomAgentsFeatureGate } from './services/customAgentsFeatureGate';
// Load backend/.env explicitly. The default `dotenv.config()` looks in
// process.cwd(), but in the electron + monorepo dev loop the cwd is the
// repo root, so `backend/.env` would silently be missed. Resolving from
// __dirname makes us cwd-independent.
dotenv.config({ path: path.join(__dirname, '..', '.env') });
startupMark('backend_process_start', { node: process.version });

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
const port = process.env.PORT || 3000;

// Initialize SQLite before anything that might need it
initDb();
// Spin up the async database worker thread. It opens its own WAL connection
// to the same data.db file so writes execute off the main thread. Hot-path
// routes (ensure-session) call dbWorker.* instead of synchronous dbRepository.
void initDbWorker(getDbPath()).catch((err) => {
  log.warn('boot', 'dbWorker failed to initialize; falling back to sync writes', { error: (err as Error).message });
});
const customAgentsFeature = new CustomAgentsFeatureGate({
  dataDir: getMichiDataDir(),
  defaultEnabled: process.env.MICHI_CUSTOM_AGENTS === '1',
});
const pendingAgentDeliveryTurnIds = new Set((getDb().prepare(`SELECT requested_turn_id FROM agent_run_watches
    WHERE delivery_status = 'pending' AND requested_turn_id IS NOT NULL`).all() as Array<{ requested_turn_id: string }>)
  .map((row) => row.requested_turn_id));
const interruptedTurns = recoverInterruptedTurns(Date.now(), pendingAgentDeliveryTurnIds);
if (interruptedTurns > 0) {
  log.warn('boot', 'recovered interrupted turns', { count: interruptedTurns });
}
log.info('boot', 'db initialized');

// Load persisted agent runtime/provider/model config (with env overrides)
loadAgentConfig();
log.info('boot', 'agent config loaded');

// Wire Michi's SQLite / secrets / config into the runtime layer's injection
// seam. MUST run before any runtime is constructed or warmed, since the
// runtime modules read getRuntimeDeps() at call-time and throw if unconfigured.
configureRuntimeDeps({
  historyStore: { getNode, listMessages, getWorkspace, getWorkspaceInstructions, hasGrant, grantPermission },
  dataDir: getMichiDataDir(),
  providerKeys: { getProviderApiKey },
  globalContext: { listThreads, searchMessages, readNode, readNodeOverview },
  agentConfig: { getAgentConfig, resolveModel, resolveReasoning },
});

const mcpRegistry = new McpSlotRegistry();
const runtimeModelCache = new FileRuntimeCatalogCache(getMichiDataDir());

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
                child = await runtime.newSession({
                    cwd: args.cwd,
                    parentChatId: args.parentChatId,
                    enableFollowUps: args.enableFollowUps,
                    sessionId: nodeId,
                    workspaceId: parentNode.workspace_id,
                    ownerUserId: workspace.owner_user_id ?? null,
                    model, provider, reasoning,
                });
                updateNodeResumeBinding(nodeId, {
                  acp_session_id: child.nativeSessionId ?? child.id,
                  runtime_id: child.runtimeId,
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
            if (!agentRunAssembly || !binding.workspaceId) return null;
            const ownerUserId = binding.ownerUserId ?? LOCAL_AGENT_OWNER_ID;
            if (binding.owner.kind === 'agent_run') {
                return agentRunAssembly.createToolInvoker({
                    kind: 'agent_run',
                    ownerUserId,
                    workspaceId: binding.workspaceId,
                    parentRunId: binding.owner.runId,
                    parentAttemptId: binding.owner.attemptId,
                });
            }
            const parentNodeId = binding.nodeId ?? binding.owner.nodeId;
            return agentRunAssembly.createToolInvoker({
                kind: 'conversation',
                ownerUserId,
                workspaceId: binding.workspaceId,
                parentNodeId,
                runtimeSessionId: binding.sessionId,
            });
        },
    });
    runtime = factory.create({
      bridge,
      mcpRegistry,
      mcpPort: Number(port),
      defaultCwd,
      modelCache: runtimeModelCache,
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

async function warmConfiguredRuntime(): Promise<void> {
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
refreshRuntimeModelsInBackground(listRuntimes(), (runtimeId, err) => {
  log.warn('boot', 'runtime model refresh failed; using cached catalog', {
    runtimeId,
    err: err.message,
  });
});

// Auth is opt-in via MICHI_REQUIRE_AUTH=true. Without the flag the
// process behaves exactly like the pre-auth backend: open CORS, no
// session middleware, no /api/auth/* handler. This keeps the Electron
// desktop app and `npm run dev` flow unchanged — auth only kicks in
// for the cloud (Docker / Railway) Pi-only deployment.
const REQUIRE_AUTH = (process.env.MICHI_REQUIRE_AUTH || '').toLowerCase() === 'true';

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
  // Open CORS for dev/desktop — same behavior as before auth was added.
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  log.info('auth', 'MICHI_REQUIRE_AUTH not set — auth middleware disabled');
}

app.use(express.json({ limit: '50mb' }));

// A server explicitly launched for remote control is protected by a shared
// bearer token. Desktop/dev remain unchanged unless MICHI_REMOTE_ACCESS=1.
app.use('/api', createRemoteAccessMiddleware());

if (REQUIRE_AUTH) {
  // requireSession — every /api/* path that is NOT /api/health or
  // /api/auth/* must have a valid session. We attach req.user /
  // req.session onto the request so downstream handlers can read
  // req.user.id without re-fetching.
  //
  // IMPORTANT: when this middleware is mounted under app.use('/api', ...),
  // Express strips the '/api' prefix from req.path inside the handler,
  // so match against the post-strip path: '/health' and '/auth/...'.
  const SESSION_PUBLIC_PATHS = [/^\/health$/, /^\/auth\//, /^\/auth-config$/, /^\/diagnostics$/, /^\/ready$/];
  app.use('/api', async (req, res, next) => {
    if (SESSION_PUBLIC_PATHS.some((re) => re.test(req.path))) return next();
    try {
      const session = await getAuthForHost(req.headers.host).api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session?.user) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      req.user = session.user;
      (req as any).session = session.session;
      next();
    } catch (err) {
      log.warn('auth', 'getSession failed', { err: (err as Error).message });
      return res.status(401).json({ error: 'unauthorized' });
    }
  });
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
  /^(?:\/api)?\/nodes\/[^/]+\/ensure-session$/, // lazy session binding before send
  /^(?:\/api)?\/workspaces$/,                // lightweight workspace index load
  /^(?:\/api)?\/workspaces\/all$/,           // full workspace hydration
  /^(?:\/api)?\/workspaces\/[^/]+\/sync$/,   // bulk chat sync (frequent client poll)
  /^(?:\/api)?\/chats\/[^/]+\/heartbeat$/,   // pane ownership heartbeat (every 10s per pane)
];
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - t0;
    const status = res.statusCode;
    if (status < 400 && ACCESS_LOG_SILENT_2XX.some((re) => re.test(req.path))) return;
    const stage = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    const fn = stage === 'error' ? log.error : stage === 'warn' ? log.warn : log.info;
    fn('http', `${req.method} ${req.path}`, { status, durMs: dur });
  });
  next();
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'michi-backend',
    connectionProtocol: 1,
    serverId: remoteServerId(),
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
  ...(!REQUIRE_AUTH ? {
    setEnabled: async (enabled: boolean) => {
      if (!enabled) {
        const inFlightAdmissions = agentRunAssembly!.beginFeatureDisable();
        const row = getDb().prepare(`SELECT COUNT(*) AS count FROM agent_runs
          WHERE status IN ('queued','preparing','running','waiting','recovering')`).get() as { count: number };
        const activeRunCount = Math.max(row.count, inFlightAdmissions);
        if (activeRunCount > 0) {
          agentRunAssembly!.cancelFeatureDisable();
          throw new CustomAgentsFeatureBusyError(activeRunCount);
        }
        try {
          customAgentsFeature.setEnabled(false);
        } catch (error) {
          agentRunAssembly!.cancelFeatureDisable();
          throw error;
        }
        return;
      }

      customAgentsFeature.setEnabled(true);
      try {
        await agentRunAssembly!.start();
        agentRunAssembly!.completeFeatureEnable();
      } catch (error) {
        customAgentsFeature.setEnabled(false);
        agentRunAssembly!.beginFeatureDisable();
        throw error;
      }
    },
  } : {}),
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
// Connection credentials belong to the local desktop gateway. A remotely
// exposed execution backend never needs to manage or replay another server's
// saved token, so keep this surface unavailable in remote mode.
if (!remoteAccessEnabled()) {
  app.use('/api', setupBackendConnectionRoutes());
}
if (REQUIRE_AUTH) {
  // BYOK provider key routes — only mounted in cloud mode. Local dev /
  // Electron continue to use the disk-based shared provider key store
  // in services/secrets.ts.
  app.use('/api', setupUserKeysRoutes());
  // Admin routes — gated by MICHI_ADMIN_EMAILS env var (requireAdmin).
  // requireSession is already applied globally above for all /api/* paths
  // not in SESSION_PUBLIC_PATHS, so req.user is already populated here.
  app.use('/api/admin', requireAdmin, setupAdminRoutes({ agentRunLifecycle }));
}
app.use('/api', setupUploadsRoutes());
app.use('/api', setupFilesRoutes());
app.use('/api', setupArtifactRoutes());
app.use('/api', setupDiffRoutes());
app.use('/api', setupMichiRoutes(chatManager));
app.use('/api', setupDigestRoutes(chatManager));
app.use('/api', setupPersistenceRoutes());
app.use('/api', setupPaneInspectionRoutes());
app.use('/api', setupBackupRoutes());
app.use('/api', setupSearchRoutes());
app.use('/api', setupVersionRoutes());

const frontendBuild = path.join(__dirname, '../../frontend/build');
const indexHtml = path.join(frontendBuild, 'index.html');

if (fs.existsSync(indexHtml)) {
  app.use(express.static(frontendBuild));
  app.get('/*splat', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(indexHtml);
  });
}

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  log.error('http', 'unhandled error', { path: req.path, err: err.message, stack: err.stack });
  res.status(500).json({ error: 'Something broke!' });
});

const listenHost = resolveListenHost();
startupMark('express_listen_start', { port: Number(port), host: listenHost });
const server = app.listen(Number(port), listenHost, () => {
  log.info('boot', 'listening', { port: Number(port), host: listenHost });
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
  log.info('boot', 'shutting down');
  streamTransport.close();
  clearInterval(agentRunCleanupTimer);
  await agentRunCleanupPass;
  await agentRunAssembly?.shutdown();
  sessionRegistry.clearAllSessions();
  // runtime.shutdown() disposes each session, which SIGTERM/SIGKILLs the
  // underlying claude/kiro child. Skipping this orphans those children: they
  // keep POSTing to /api/mcp/:slotId on the old port and the next backend
  // instance 404s them ("unknown mcp slot").
  await Promise.allSettled(listRuntimes().map((runtime) => runtime.shutdown()));
  sshTunnelManager.shutdown();
  closeAllArtifactWatchers();
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
