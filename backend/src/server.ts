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
import { setupBackupRoutes } from './routes/backup';
import { setupSearchRoutes } from './routes/search';
import { setupVersionRoutes } from './routes/version';
import adminRouter from './routes/admin';
import { setupAgentRoutes } from './routes/agent';
import { setupUserKeysRoutes } from './routes/userKeys';
import { setupUploadsRoutes } from './routes/uploads';
import { setupFilesRoutes } from './routes/files';
import { setupArtifactRoutes } from './routes/artifacts';
import { ChatManager } from './services/chatManager';
import { getAuth, getAuthForHost, runAuthMigrations } from './services/auth';
import { requireAdmin } from './routes/middleware/admin';
import { McpSlotRegistry, mountMcp } from './services/mcpServer';
import { initDb, closeDb, closeAuditDb } from './services/db';
import { recordAudit } from './services/audit';
import { getAgentConfig, loadAgentConfig, reconcileRuntimeWithRegistered, resolveModel, resolveReasoning } from './services/agentConfig';
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
import { listThreads, searchMessages, readNode } from './services/globalContext';
import { FileRuntimeModelCache } from './agents/runtimeModelCache';
import { refreshRuntimeModelsInBackground } from './agents/runtimeModelRefresh';

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
const interruptedTurns = recoverInterruptedTurns();
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
  globalContext: { listThreads, searchMessages, readNode },
  agentConfig: { getAgentConfig, resolveModel, resolveReasoning },
});

const mcpRegistry = new McpSlotRegistry();
const runtimeModelCache = new FileRuntimeModelCache(getMichiDataDir());

// Register the enabled runtimes (filtered by MICHI_ENABLED_RUNTIMES, or
// all of them locally) through a single factory loop. Each factory
// creates its runtime with a bridge whose createChild calls
// runtime.newSession and registers the child in sessionRegistry. Provider
// env bindings are collected here and pushed into secrets.ts after
// registration.
const allEnvBindings: ProviderEnvBinding[] = [];
let kiroRuntime: KiroRuntime | undefined;
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
            let child: Awaited<ReturnType<AgentRuntime['newSession']>>;
            try {
                child = await runtime.newSession({
                    cwd: args.cwd,
                    parentChatId: args.parentChatId,
                    enableFollowUps: args.enableFollowUps,
                    sessionId: nodeId,
                    workspaceId: parentNode.workspace_id,
                    ownerUserId: workspace.owner_user_id ?? null,
                });
            } catch (err) {
                rollbackProvisionalSpawnNode(
                  nodeId,
                  parentNode.workspace_id,
                  workspace.owner_user_id ?? null,
                );
                throw err;
            }
            sessionRegistry.registerSession(child, workspace.owner_user_id ?? null);
            // Runtime ids (notably Kiro/Claude) differ from node ids. Persist
            // the reverse mapping before publishing the spawn event so cloud
            // /message ownership accepts this freshly spawned live session.
            updateNodeResumeBinding(nodeId, {
              acp_session_id: child.nativeSessionId ?? child.id,
              runtime_id: child.runtimeId,
              current_mode_id: child.currentModeId ?? null,
            });
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
const warmPromise = warmConfiguredRuntime()
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
    allowedHeaders: ['Content-Type'],
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
    allowedHeaders: ['Content-Type'],
  }));
  log.info('auth', 'MICHI_REQUIRE_AUTH not set — auth middleware disabled');
}

app.use(express.json({ limit: '50mb' }));

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
  res.status(200).json({ status: 'healthy' });
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
mountMcp(mcpRouter, mcpRegistry);
app.use('/api', mcpRouter);

app.use('/api', setupAgentRoutes());
if (REQUIRE_AUTH) {
  // BYOK provider key routes — only mounted in cloud mode. Local dev /
  // Electron continue to use the disk-based shared provider key store
  // in services/secrets.ts.
  app.use('/api', setupUserKeysRoutes());
  // Admin routes — gated by MICHI_ADMIN_EMAILS env var (requireAdmin).
  // requireSession is already applied globally above for all /api/* paths
  // not in SESSION_PUBLIC_PATHS, so req.user is already populated here.
  app.use('/api/admin', requireAdmin, adminRouter);
}
app.use('/api', setupUploadsRoutes());
app.use('/api', setupFilesRoutes());
app.use('/api', setupArtifactRoutes());
app.use('/api', setupMichiRoutes(chatManager));
app.use('/api', setupDigestRoutes(chatManager));
app.use('/api', setupPersistenceRoutes());
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

startupMark('express_listen_start', { port: Number(port) });
const server = app.listen(port, () => {
  log.info('boot', 'listening', { port: Number(port) });
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

let shuttingDown = false;
const gracefulShutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('boot', 'shutting down');
  sessionRegistry.clearAllSessions();
  // runtime.shutdown() disposes each session, which SIGTERM/SIGKILLs the
  // underlying claude/kiro child. Skipping this orphans those children: they
  // keep POSTing to /api/mcp/:slotId on the old port and the next backend
  // instance 404s them ("unknown mcp slot").
  await Promise.allSettled(listRuntimes().map((runtime) => runtime.shutdown()));
  closeDb();
  closeAuditDb();
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
process.once('SIGUSR2', () => {
  void gracefulShutdown().finally(() => {
    process.kill(process.pid, 'SIGUSR2');
  });
  setTimeout(() => process.exit(1), 5000).unref();
});
