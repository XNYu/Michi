import os from 'node:os';
import path from 'node:path';
import { isCrewMemoryMode, type ChatPermissionMode } from 'michi-shared';
import { ownerMode, type AgentReasoning, type AgentSession, type RuntimeSessionOwner, type RuntimeToolProfile } from '../contract/types';
import {
  RuntimeHostConfigError,
  SessionProfileUnsupportedError,
  type BackgroundSubagentSink,
  type BackgroundTurnConsumer,
  type CrewMemoryStore,
  type DefaultModelChangedEvent,
  type FirstTurnPrefixInput,
  type ForkAnchorStore,
  type HostEdgeRecord,
  type HostNodeRecord,
  type HostWorkspaceRecord,
  type KiroForkAnchor,
  type NativeBindingPort,
  type PermissionPolicyPort,
  type PrincipalResolver,
  type PromptPolicyPort,
  type RuntimeConfigPort,
  type RuntimeHost,
  type RuntimeLogLevel,
  type RuntimeObservability,
  type RuntimePortName,
  type SessionProfilePort,
  type SessionRegistryPort,
  type TitleModelConfig,
  type TitlePolicy,
  type TurnMetadataTracker,
  type WorkflowRunSink,
} from '../contract/host';
import { createSessionDirectory } from './sessionDirectory';
import { withSessionDirectory } from './sessionPortDirectory';

type PortOverride<T> = T extends (...args: never[]) => unknown ? T : Partial<T>;

/**
 * Per-port overrides, merged method by method over the defaults. Nested
 * objects (config.features, bindings.forkAnchors, bindings.crewMemory,
 * observability.perf, observability.streamProbe) are replaced as a unit. An
 * optional port given as `undefined` is removed; a required one throws
 * RuntimeHostConfigError.
 */
export type DefaultHostPortOverrides = {
  [K in keyof RuntimeHost]?: PortOverride<NonNullable<RuntimeHost[K]>>;
};

/**
 * A complete RuntimeHost kept in memory: no host prompts but a generic MCP
 * session reminder, no restricted profile beyond the contract's restricted
 * flag, live sessions only, Ask permissions with in-memory grants, console
 * logging. A new host starts from it and overrides the methods it owns:
 *
 *   const host = createDefaultHost({ principal: 'me', ports: { bindings: { nodeBinding, workspace } } });
 *
 * A session whose tool profile carries the restricted flag is locked down by
 * its adapter to the host's own tools. A Codex one runs locked down (read-only,
 * offline, every MCP server but the host's off); before contract v1 this host
 * refused it instead. Claude denies its tool calls unless the adapter's
 * options give a restrictedToolApproval; Kiro refuses it.
 *
 * "No host prompts" includes the context callers pass in: the default prompt
 * port does not render extraContexts, mergeContexts, contextManifest,
 * ancestors, workspaceInstructions or a branchContext transcript, and warns
 * once per field the first time one is dropped. Provide ports.prompt to keep them.
 * The one text it adds is mcpSessionReminder, which tells a session that
 * shares one MCP URL with others (a Kiro v3 chat session) the id to pass to
 * the host's tools; ports.prompt.mcpSessionReminder replaces it.
 */
export interface DefaultHostOptions {
  /** Principal for sessions without an owner user. Default 'local'. */
  principal?: string;
  /** Lowest level written; 'silent' writes nothing. Default 'info'. */
  logLevel?: RuntimeLogLevel | 'silent';
  /** Where log lines go. Default the global console. */
  logSink?: Pick<Console, RuntimeLogLevel>;
  /** Default `~/.agent-runtime`. Not created. */
  dataDir?: string;
  defaultModels?: Readonly<Record<string, string>>;
  defaultReasoning?: Readonly<Record<string, AgentReasoning>>;
  /** Sidecar title models by runtime id. Absent runtimes generate no sidecar titles. */
  titleModels?: Readonly<Record<string, TitleModelConfig>>;
  /** Workflow feature flag; default off. */
  workflows?: boolean | ((runtimeId: string, userId?: string | null) => boolean);
  /** Chat permission mode; default 'ask'. */
  permissionMode?: ChatPermissionMode | ((owner: RuntimeSessionOwner | undefined, ownerUserId?: string | null) => ChatPermissionMode);
  /** Initial in-memory rows read through bindings. */
  nodes?: readonly HostNodeRecord[];
  workspaces?: readonly HostWorkspaceRecord[];
  edges?: readonly HostEdgeRecord[];
  /**
   * Method overrides. The defaults call each other through the merged host,
   * so they see overridden methods. Writes (recordNativeSessionId,
   * crewMemory.pin) still go to the in-memory node records: a host that
   * overrides nodeBinding owns node records and overrides those writers too.
   * Replace `sessions` as a unit, all of its methods: its defaults share one
   * in-memory directory and do not call each other through the host, so a
   * partial override would split registrations and lookups between two.
   * Without a `sessions` override, createRuntimeManager({ host }) uses that
   * directory, which reads this host's principal, onSessionStateChanged and
   * observability: replace those here, not on a copy of the returned host,
   * which createRuntimeManager refuses. With an override of all five
   * `sessions` methods the port is the host's own; createRuntimeManager
   * refuses a partial one (see RuntimeManagerOptions).
   */
  ports?: DefaultHostPortOverrides;
}

const DEFAULT_TITLE_TIMEOUT_MS = 15_000;
const LOG_LEVELS: readonly RuntimeLogLevel[] = ['debug', 'info', 'warn', 'error'];

export function createDefaultHost(options: DefaultHostOptions = {}): RuntimeHost {
  // The defaults reach other ports through `host`, the merged result, so an
  // override of one method is seen by every default that uses it.
  const host = {} as RuntimeHost;
  const defaults: RuntimeHost = {
    config: defaultConfig(options),
    prompt: defaultPrompt(host),
    profile: defaultProfile(),
    bindings: defaultBindings(host, options),
    sessions: defaultSessions(host),
    permissions: defaultPermissions(host, options),
    principal: defaultPrincipal(options.principal ?? 'local'),
    observability: defaultObservability(options),
    title: defaultTitle(),
    backgroundTurns: defaultBackgroundTurns(host),
    workflows: defaultWorkflows(),
    backgroundSubagents: defaultBackgroundSubagents(),
  };
  return Object.assign(host, mergePorts(defaults, options.ports ?? {}));
}

/** Ports every RuntimeHost has; only the optional ones may be removed. */
const REQUIRED_PORTS = [
  'config', 'prompt', 'profile', 'bindings', 'sessions', 'permissions', 'principal', 'observability', 'title',
  'backgroundTurns', 'workflows', 'backgroundSubagents',
] as const;

function mergePorts(defaults: RuntimeHost, overrides: DefaultHostPortOverrides): RuntimeHost {
  const removed = REQUIRED_PORTS.filter((name) => Object.prototype.hasOwnProperty.call(overrides, name) && overrides[name] === undefined);
  if (removed.length > 0) throw new RuntimeHostConfigError('createDefaultHost', removed);
  const merged: Record<string, unknown> = { ...defaults };
  for (const [name, override] of Object.entries(overrides)) {
    const base = merged[name];
    if (override === undefined) delete merged[name];
    else if (typeof override === 'function' || typeof base !== 'object' || base === null) merged[name] = override;
    else merged[name] = { ...base, ...override };
  }
  return merged as unknown as RuntimeHost;
}

/**
 * Throws one RuntimeHostConfigError naming every port in `required` that
 * `host` lacks. Adapters call it at construction with the ports they use.
 */
export function assertHostPorts(
  host: Partial<RuntimeHost> | null | undefined,
  required: readonly RuntimePortName[],
  who: string,
): void {
  const missing = required.filter((name) => {
    if (name === 'bindings.crewMemory') return host?.bindings?.crewMemory == null;
    return host?.[name] == null;
  });
  if (missing.length > 0) throw new RuntimeHostConfigError(who, missing);
}

function defaultConfig(options: DefaultHostOptions): RuntimeConfigPort {
  const listeners = new Set<(event: DefaultModelChangedEvent) => void>();
  const workflows = options.workflows;
  return {
    defaultModel: (runtimeId) => options.defaultModels?.[runtimeId] ?? '',
    defaultReasoning: (runtimeId) => options.defaultReasoning?.[runtimeId],
    titleModel: (runtimeId) => options.titleModels?.[runtimeId] ?? { model: null, timeoutMs: DEFAULT_TITLE_TIMEOUT_MS },
    // The defaults never change at runtime, so nothing is ever emitted.
    onDefaultModelChanged: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    features: {
      workflows: (runtimeId, userId) => typeof workflows === 'function' ? workflows(runtimeId, userId) : workflows === true,
    },
    dataDir: () => options.dataDir ?? path.join(os.homedir(), '.agent-runtime'),
  };
}

/** No metadata protocol: nothing is validated, accepted or suppressed. */
function inertTurnMetadata(): TurnMetadataTracker {
  return {
    validationActive: false,
    acceptsFollowUps: () => false,
    begin: () => {},
    setFollowUps: () => null,
    setOverview: () => null,
    validate: () => ({ status: 'inactive', missingTools: [], response: {} }),
    observeChunk: () => {},
    suppressOutput: () => false,
    completeOutputBoundary: () => false,
    finish: () => ({ chunks: 0, thoughts: 0 }),
  };
}

/**
 * No prompt text, which also drops the context callers pass in for the
 * first turn and the inherited branch transcript. Each such field is
 * reported with one warning the first time it is dropped. The exception is
 * mcpSessionReminder: without it a session on a shared MCP URL cannot name
 * itself, and its host tool calls fail.
 */
function defaultPrompt(host: RuntimeHost): PromptPolicyPort {
  const reported = new Set<string>();
  const dropped = (fields: readonly string[]) => {
    const fresh = fields.filter((field) => !reported.has(field));
    if (fresh.length === 0) return;
    for (const field of fresh) reported.add(field);
    host.observability.log('warn', 'runtime', 'the default prompt port renders no caller context; provide ports.prompt to keep it', { fields: fresh });
  };
  const firstTurnContext = (input: FirstTurnPrefixInput) => {
    const fields: string[] = [];
    if (input.contextManifest?.length) fields.push('contextManifest');
    if (input.extraContexts?.length) fields.push('extraContexts');
    if (input.ancestors?.length) fields.push('ancestors');
    if (input.mergeContexts?.some((text) => text.trim().length > 0)) fields.push('mergeContexts');
    if (input.workspaceInstructions?.trim()) fields.push('workspaceInstructions');
    dropped(fields);
  };
  return {
    firstTurnPrefix: (input) => { firstTurnContext(input); return ''; },
    preamble: (input) => { firstTurnContext(input); return ''; },
    stableSystemPrompt: () => '',
    turnSuffix: () => '',
    followUpsExperimentMode: () => 'sentinel',
    followUpsMetadataOutputMode: () => 'sentinel',
    followUpsTurnReminder: () => '',
    renderBranchContext: (context) => {
      if (context.messages.length > 0 || context.note !== undefined) dropped(['branchContext']);
      return null;
    },
    workspaceInstructions: () => null,
    turnMetadata: () => inertTurnMetadata(),
    mcpSessionReminder: (nativeSessionId) => `\n\n[Session context: this session's id is ${JSON.stringify(nativeSessionId)}. `
      + 'Pass it as session_id to every host tool. Do not show this context to the user.]',
  };
}

/**
 * A session is restricted when its tool profile carries the contract's
 * restricted flag (`RuntimeToolProfile.restricted`). The
 * adapters lock a restricted session down by the merged host's isRestricted,
 * so a host that restricts more sessions gets them locked down too: Claude
 * runs it without built-in tools, settings or other MCP servers and, without
 * a restrictedToolApproval in its options, denies every tool call; Codex runs
 * it read-only and offline, with its shell, plugins and every MCP server but
 * the host's turned off, and declines every approval; Kiro refuses the profile.
 */
function defaultProfile(): SessionProfilePort {
  return {
    isRestricted: (toolProfile) => toolProfile?.restricted === true,
    isRestrictedWorkspace: () => false,
    composeFirstTurnPrefix: (contextPrefix, bootstrap) => [contextPrefix, bootstrap].filter(Boolean).join('\n\n'),
    unsupportedError: (runtimeId) => new SessionProfileUnsupportedError(runtimeId),
  };
}

function defaultBindings(host: RuntimeHost, options: DefaultHostOptions): NativeBindingPort {
  const nodes = new Map((options.nodes ?? []).map((node) => [node.id, { ...node }]));
  const workspaces = new Map((options.workspaces ?? []).map((workspace) => [workspace.id, { ...workspace }]));
  const edges = (options.edges ?? []).map((edge) => ({ ...edge }));
  // Writes create a node record on first sight: an in-memory host has no
  // separate node table that could refuse the binding.
  const upsertNode = (nodeId: string): HostNodeRecord => {
    let node = nodes.get(nodeId);
    if (!node) {
      node = { id: nodeId, workspace_id: '', kind: 'chat', status: 'idle' };
      nodes.set(nodeId, node);
    }
    return node;
  };
  return {
    nodeBinding: (nodeId) => {
      const node = nodes.get(nodeId);
      return node ? { ...node } : null;
    },
    workspace: (workspaceId) => {
      const workspace = workspaces.get(workspaceId);
      return workspace ? { ...workspace } : null;
    },
    edges: (workspaceId) => edges.filter((edge) => edge.workspace_id === workspaceId).map((edge) => ({ ...edge })),
    recordNativeSessionId: (owner, nativeSessionId) => {
      // Only an interactive owner's session has a durable binding (the adapter fails closed on the throw).
      if (ownerMode(owner) !== 'interactive') throw new Error('Only an interactive owner records a native session id');
      const node = upsertNode(owner.key);
      node.external_session_id = nativeSessionId;
      node.acp_session_id = nativeSessionId;
    },
    forkAnchors: memoryForkAnchors(host),
    crewMemory: memoryCrewMemory(upsertNode),
  };
}

/**
 * Anchors are saved only for a node still bound to that native session and,
 * for Claude, read back only while the chat is live, still bound to it, in a
 * live workspace the caller owns: the checks Michi's store makes in SQL. The
 * in-memory host records neither messages nor a runtime per node, so those
 * two checks of Michi's are not made here.
 */
function memoryForkAnchors(host: RuntimeHost): ForkAnchorStore {
  const kiro = new Map<string, KiroForkAnchor>();
  const claude = new Map<string, string>();
  const key = (...parts: string[]) => parts.join('\u0000');
  const boundChat = (nodeId: string, nativeSessionId: string): HostNodeRecord | null => {
    const node = host.bindings.nodeBinding(nodeId);
    if (!node || node.kind !== 'chat' || node.deleted_at || node.purged_at) return null;
    return (node.external_session_id ?? node.acp_session_id) === nativeSessionId ? node : null;
  };
  return {
    saveKiroForkAnchor: (input) => {
      if (host.bindings.nodeBinding(input.nodeId)?.acp_session_id !== input.nativeSessionId) return;
      const anchor = { ...input.anchor };
      kiro.set(key(input.nodeId, input.nativeSessionId, input.engine, input.assistantMessageId), anchor);
      if (input.userMessageId) kiro.set(key(input.nodeId, input.nativeSessionId, input.engine, input.userMessageId), anchor);
    },
    readKiroForkAnchor: (nodeId, nativeSessionId, engine, messageId) => {
      const anchor = kiro.get(key(nodeId, nativeSessionId, engine, messageId));
      return anchor ? { ...anchor } : null;
    },
    saveClaudeForkAnchor: (input) => {
      if (!input.nativeMessageId || !input.assistantMessageId) return;
      if (!boundChat(input.nodeId, input.nativeSessionId)) return;
      claude.set(key(input.nodeId, input.nativeSessionId, input.assistantMessageId), input.nativeMessageId);
      // A user cut maps only to the prompt's own native id, never the answer's.
      if (input.userMessageId && input.nativeUserMessageId) {
        claude.set(key(input.nodeId, input.nativeSessionId, input.userMessageId), input.nativeUserMessageId);
      }
    },
    readClaudeForkAnchor: (input) => {
      const nativeMessageId = claude.get(key(input.nodeId, input.nativeSessionId, input.messageId));
      const node = nativeMessageId ? boundChat(input.nodeId, input.nativeSessionId) : null;
      if (!node || (input.workspaceId != null && node.workspace_id !== input.workspaceId)) return null;
      const workspace = host.bindings.workspace(node.workspace_id);
      if (!workspace || workspace.deleted_at || workspace.archived_at) return null;
      const principal = host.principal.resolve(input.ownerUserId);
      if (!host.principal.workspaceOwnerMatches(workspace.owner_user_id ?? null, principal)) return null;
      return nativeMessageId ?? null;
    },
  };
}

/** No per-user default is stored here, so every user starts persistent. */
function memoryCrewMemory(upsertNode: (nodeId: string) => HostNodeRecord): CrewMemoryStore {
  return {
    defaultMode: () => 'persistent',
    pin: (nodeId, mode) => {
      if (!isCrewMemoryMode(mode)) throw new Error('Invalid Crew memory mode');
      upsertNode(nodeId).crew_memory_mode = mode;
    },
  };
}

/**
 * Live sessions in one in-memory session directory; this host keeps no
 * history behind it. So ensureAncestorChainLoaded adds nothing, and
 * getAncestors walks the live sessions only: a chain ends at the first
 * ancestor that is no longer registered. State changes of registered
 * sessions reach the merged host's onSessionStateChanged and log. The
 * directory is recorded behind the port, so a manager built from this host
 * shares it.
 */
function defaultSessions(host: RuntimeHost): SessionRegistryPort {
  const directory = createSessionDirectory({ host, enforceUserOwnership: () => host.principal.enforceUserOwnership() });
  return withSessionDirectory({
    ensureAncestorChainLoaded: () => {},
    getSession: (chatId) => directory.get(chatId),
    getAncestors: (chatId) => {
      const ancestors: AgentSession[] = [];
      const visited = new Set<string>();
      let cursor = directory.get(chatId)?.parentChatId;
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const session = directory.get(cursor);
        if (!session) break;
        ancestors.unshift(session);
        cursor = session.parentChatId;
      }
      return ancestors;
    },
    registerSession: (session, ownerUserId, owner) => directory.register(session, ownerUserId, owner),
    dropSession: (chatId) => directory.drop(chatId),
  }, directory, host);
}

function defaultPermissions(host: RuntimeHost, options: DefaultHostOptions): PermissionPolicyPort {
  const grants = new Set<string>();
  const configured = options.permissionMode;
  // Grants are held per owner: its mode and key name it.
  const grantOwner = (owner: RuntimeSessionOwner) => `${ownerMode(owner)}\u0000${owner.key}`;
  const grantKey = (owner: RuntimeSessionOwner, ownerUserId: string | null | undefined, toolName: string) =>
    `${grantOwner(owner)}\u0000${ownerUserId ?? ''}\u0000${toolName}`;
  return {
    mode: (owner, ownerUserId) => typeof configured === 'function' ? configured(owner, ownerUserId) : configured ?? 'ask',
    resolveOwnerUserId: (_owner, ownerUserId) => ownerUserId ?? null,
    decide: (request) => {
      const mode = request.mode ?? host.permissions.mode(request.owner, request.ownerUserId);
      if (mode !== 'ask') return 'allow';
      const userId = host.permissions.resolveOwnerUserId(request.owner, request.ownerUserId);
      return grants.has(grantKey(request.owner, userId, request.toolName)) ? 'allow' : 'ask';
    },
    grant: (request) => {
      grants.add(grantKey(request.owner, host.permissions.resolveOwnerUserId(request.owner, request.ownerUserId), request.toolName));
    },
  };
}

function defaultPrincipal(local: string): PrincipalResolver {
  return {
    resolve: (ownerUserId) => ownerUserId ?? local,
    // Rows stored before ownership existed have no owner and belong to the local principal.
    workspaceOwnerMatches: (stored, principal) => stored === principal || (stored === null && principal === local),
    enforceUserOwnership: () => false,
  };
}

function defaultObservability(options: DefaultHostOptions): RuntimeObservability {
  const threshold = options.logLevel === 'silent' ? LOG_LEVELS.length : LOG_LEVELS.indexOf(options.logLevel ?? 'info');
  const sink = options.logSink ?? console;
  return {
    log: (level, scope, msg, data) => {
      if (LOG_LEVELS.indexOf(level) < threshold) return;
      if (data === undefined) sink[level](`[${scope}] ${msg}`);
      else sink[level](`[${scope}] ${msg}`, data);
    },
    perf: {
      now: () => performance.now(),
      mark: () => {},
      measure: () => {},
    },
  };
}

/** No runtime generates titles; the host titles threads itself, if at all. */
function defaultTitle(): TitlePolicy {
  return { enabled: () => false, prompt: () => '' };
}

/** Nobody can see a self-started turn here: stop it, then drain it so the session's turn mutex is released. */
function defaultBackgroundTurns(host: RuntimeHost): BackgroundTurnConsumer {
  return {
    consume: (turn) => {
      void (async () => {
        try { await turn.cancel?.(); } catch { /* draining still ends it */ }
        try {
          for await (const discarded of turn.events) void discarded;
        } catch { /* the turn is discarded either way */ }
        host.observability.log('debug', 'runtime', 'background turn discarded: the host has no turn consumer', { chatId: turn.chatId });
      })();
    },
    isActive: () => false,
    isOwnerTurnActive: () => false,
    hasPendingSelfTurn: () => false,
  };
}

/** Workflow runs are not tracked: updates are dropped and approvals fall back to the session. */
function defaultWorkflows(): WorkflowRunSink {
  return {
    update: () => null,
    updateKnown: () => null,
    registerControls: () => {},
    requestApproval: () => false,
    withdrawApproval: () => {},
    releaseControls: () => {},
  };
}

function defaultBackgroundSubagents(): BackgroundSubagentSink {
  return { report: () => {}, end: () => {} };
}
