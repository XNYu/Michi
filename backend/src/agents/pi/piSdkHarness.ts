import { finalizeTurnContent } from 'michi-shared';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { PiSessionDeps } from './PiSession';
import { getMichiDataDir } from '../../services/dataDir';
import { loadPiAi, loadPiBundle } from './piAi';
import type { ChatMessage } from '../types';
import { unfinishedToolResults } from './piToolInterruption';
import { createPiExtensionUi, PI_EXTENSION_UI_MODE, type PiExtensionUiHost } from './piExtensionUi';
import { PiToolApprovalLedger } from './piToolApproval';
import { log } from '../../services/logger';
import { PI_TOOL_SEARCH_TOOL_NAME, renderDeferredMcpSection } from './mcpToolBridge';

/** Dialogs without a running turn: every one returns Pi's cancel value. */
const NO_TURN_UI: PiExtensionUiHost = { activeTurn: () => undefined, requestUserInput: async () => null, notify: () => {} };

declare const __MICHIBUNDLE__: boolean | undefined;
const nativeImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
export async function loadPiCodingAgent(): Promise<any> {
  if (typeof __MICHIBUNDLE__ !== 'undefined' && __MICHIBUNDLE__) {
    return (await loadPiBundle()).coding;
  }
  return nativeImport('@earendil-works/pi-coding-agent');
}

/** Hash every security boundary; public node ids alone are never a storage scope. */
export function piSdkSessionDirectory(id: string, deps: PiSessionDeps): string {
  const scope = JSON.stringify([deps.ownerUserId, deps.workspaceId, deps.owner, deps.profileHash ?? null, id]);
  return path.join(getMichiDataDir(), 'pi-sessions', createHash('sha256').update(scope).digest('hex'));
}

type ChatMessageLike = { role: string; content: any };

function historyHash(messages: ChatMessageLike[]): string {
  return createHash('sha256').update(JSON.stringify(messages.map(message => {
    const text = typeof message.content === 'string' ? message.content : message.content[0]?.text ?? '';
    return { role: message.role, content: message.role === 'assistant' ? finalizeTurnContent(text) : text.trim() };
  }))).digest('hex');
}

/**
 * The host history a native transcript was last settled against: its hash, how
 * many messages it covered and the transcript leaf at that point. Older
 * checkpoints hold only the hash and match the whole history exactly.
 */
interface HostCheckpoint { hash: string; count?: number; leafId?: string | null }

function readHostCheckpoint(file: string): HostCheckpoint | null {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(raw) as Partial<HostCheckpoint> | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.hash === 'string') {
      return {
        hash: parsed.hash,
        ...(Number.isSafeInteger(parsed.count) && parsed.count! >= 0 ? { count: parsed.count } : {}),
        ...(typeof parsed.leafId === 'string' || parsed.leafId === null ? { leafId: parsed.leafId } : {}),
      };
    }
  } catch { /* the original hash-only format */ }
  return { hash: raw };
}

/**
 * Whether the native transcript still describes the host history. Every
 * settled turn checkpoints, so host rows past the checkpointed prefix belong
 * to turns that never settled: a process that died mid-turn. Those rows are
 * the only difference allowed; any other edit (cut, rollback, retry) retires
 * the transcript.
 */
function matchHostCheckpoint(saved: HostCheckpoint | null, host: ChatMessageLike[]): 'exact' | 'interrupted' | null {
  if (!saved) return null;
  if (saved.hash === historyHash(host)) return 'exact';
  if (saved.count === undefined || saved.count >= host.length) return null;
  return saved.hash === historyHash(host.slice(0, saved.count)) ? 'interrupted' : null;
}

/** Native entries after the checkpointed leaf; null when that leaf is not on the current branch. */
function entriesAfterLeaf(manager: any, leafId: string | null | undefined): any[] | null {
  if (leafId === undefined) return null;
  const branch: any[] = manager.getBranch();
  if (leafId === null) return branch;
  const index = branch.findIndex((entry) => entry.id === leafId);
  return index < 0 ? null : branch.slice(index + 1);
}

/** Rollback runs invalidate the native view before another model request. */
export function invalidatePiSdkTranscript(id: string, deps: PiSessionDeps): void {
  const directory = piSdkSessionDirectory(id, deps);
  if (fs.existsSync(directory)) fs.writeFileSync(path.join(directory, 'invalidated'), 'agent-core');
}

/** Host-chosen SDK features; the agent-core engine has neither. */
export interface PiSdkFeatures {
  /** Load AGENTS.md / CLAUDE.md from cwd and its ancestors (never ~/.pi). */
  projectContext?: boolean;
}

const MCP_SERVERS_SECTION = 'mcp_servers';
const isDeferred = (tool: any) => tool.exposure === 'deferred';

/** Deferred tools tool_search loaded on this branch, from the transcript's loadout. */
function loadedDeferredTools(ai: any, manager: any, tools: readonly any[]): string[] {
  const deferred = new Set(tools.filter(isDeferred).map(tool => tool.name));
  if (deferred.size === 0) return [];
  const systemMessages = manager.getBranch().flatMap((entry: any) =>
    entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : []);
  if (systemMessages.length === 0) return [];
  return ai.getCurrentTools(systemMessages).map((tool: any) => tool.name).filter((name: string) => deferred.has(name));
}

/**
 * A full SDK lifecycle around Michi's Agent. No default discovery, auth files,
 * provider config, built-in shell tools, or user-global packages are inherited.
 * Project context files are opt-in. Host MCP tools with `deferred` exposure
 * stay undeclared until Pi's tool_search loads them.
 * Extension factories below are an explicit host-owned lifecycle entry point;
 * their UI is Michi's (piExtensionUi, passed in as `options.extensionUi`).
 */
export async function createPiSdkHarness(
  id: string, deps: PiSessionDeps, core: any, { extensionUi, ...options }: any, features: PiSdkFeatures = {},
): Promise<any> {
  const sdk = await loadPiCodingAgent();
  const ai = await loadPiAi();
  const directory = piSdkSessionDirectory(id, deps);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const transcript = path.join(directory, 'session.jsonl');
  const settings = sdk.SettingsManager.inMemory({
    retry: { enabled: false }, // Michi/provider retry policy owns retries.
    compaction: { enabled: true },
    cacheWarming: 'off',
    images: { autoResize: false }, // Michi already enforces attachment budgets.
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new (ai as any).InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(directory, 'models-cache.json'), refreshOnCreate: false,
  });
  // The SDK's own sessions convert its transcript-only roles (compaction and
  // branch summaries, custom messages) for the model. agent-core's default
  // drops them, which would discard every compaction summary from the context.
  const agent = new core.Agent({ convertToLlm: sdk.convertToLlm, ...options });
  let hostExtension: any;
  // Every tool runs only with the arguments Michi approved (piToolApproval).
  const approvals = new PiToolApprovalLedger();
  const guardTool = approvals.guard;
  const ui = createPiExtensionUi((extensionUi as PiExtensionUiHost | undefined) ?? NO_TURN_UI);
  // Handlers run in this order: Michi's host, the explicit extensions (each
  // with ctx.ui attributed to its SDK path), then Michi's approval, last, so
  // it decides on the arguments every other tool_call handler left.
  const extensions = (deps.sdkExtensionFactories ?? []).map((factory, index) =>
    ui.scope(factory, `<inline:${index + 2}>${factory.name ? ` (${factory.name})` : ''}`, guardTool));
  const baseTools: Record<string, any> = Object.fromEntries(options.initialState.tools.map((tool: any) => [tool.name, tool]));
  const loader = new sdk.DefaultResourceLoader({
    // agentDir is this session's private directory, so only cwd and its
    // ancestors can contribute context files, never a user-global ~/.pi one.
    cwd: deps.cwd, agentDir: directory, settingsManager: settings,
    noExtensions: true, disabledBuiltinExtensions: ['mcp'], noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: features.projectContext !== true,
    systemPrompt: options.initialState.systemPrompt,
    extensionFactories: [{ name: 'michi-host', factory: (pi: any) => {
      hostExtension = pi;
      for (const tool of options.initialState.tools) pi.registerTool(guardTool(tool));
      pi.on('tool_result', async (event: any) => options.afterToolCall?.({
        toolCall: { name: event.toolName, id: event.toolCallId }, args: event.input,
        result: { content: event.content, details: event.details }, isError: event.isError,
      }, agent.signal));
      // tool_search lists no servers; name them so the model knows what to load.
      pi.on('before_agent_start', (event: any) => {
        const sections = event.systemPromptOptions.sections;
        const section = renderDeferredMcpSection(Object.values(baseTools));
        if (section) sections[MCP_SERVERS_SECTION] = section;
        else delete sections[MCP_SERVERS_SECTION];
      });
      // Pi's tool_search goes through the same approval ledger as every tool.
    } }, { name: 'michi-tool-search', factory: ui.scope(sdk.createToolSearchExtension(), '<builtin:tool_search>', guardTool) },
    ...extensions, { name: 'michi-approval', factory: (pi: any) => {
      pi.on('tool_call', (event: any) => approvals.decide(event, (name, args) => options.beforeToolCall?.({
        toolCall: { name, id: event.toolCallId }, args,
      }, agent.signal)));
    } }],
  });
  await loader.reload();
  const checkpoint = path.join(directory, 'host-history.sha256');
  const invalidated = path.join(directory, 'invalidated');
  const host = deps.initialMessages ?? [];
  const saved = deps.restoreNative ? readHostCheckpoint(checkpoint) : null;
  const match = matchHostCheckpoint(saved, host);
  let manager = fs.existsSync(transcript) && match !== null && !fs.existsSync(invalidated)
    ? sdk.SessionManager.open(transcript, directory, deps.cwd)
    : undefined;
  // Host rows past the checkpoint: the turn the process died in, and any
  // turns another runtime ran on this node since.
  const tail = match === 'interrupted' && saved?.count !== undefined ? host.slice(saved.count) : [];
  let carryTail = false;
  if (manager && tail.length > 0) {
    const recorded = entriesAfterLeaf(manager, saved?.leafId);
    if (recorded && !recorded.some((entry: any) => entry.type === 'message' && entry.message?.role === 'user')) {
      // The SDK recorded no prompt after the checkpoint: carry those rows as text.
      carryTail = true;
    } else if (!recorded || tail.filter((message) => message.role === 'user').length > 1) {
      // Its native record covers one interrupted turn at most; anything more
      // cannot be lined up with the host rows, so start from them instead.
      manager = undefined;
    }
  }
  if (fs.existsSync(transcript) && !manager) {
    // SQLite replay/cut/rollback is authoritative. Retain the original native
    // tree for recovery; never silently resume an older view or erase it.
    fs.renameSync(transcript, path.join(directory, `retired-${Date.now()}-${process.hrtime.bigint()}.jsonl`));
  }
  fs.rmSync(invalidated, { force: true });
  const resumed = !!manager;
  if (!manager) {
    manager = sdk.SessionManager.create(deps.cwd, directory);
    manager.setSessionFile(transcript);
    for (const message of options.initialState.messages ?? []) manager.appendMessage(message);
  } else {
    // Calls still running when the process died get a result that says so,
    // not the provider adapter's "No result provided", which reads as not run.
    for (const result of unfinishedToolResults(manager.buildSessionContext().messages)) manager.appendMessage(result);
    if (carryTail) for (const message of tail) manager.appendMessage(message);
  }
  agent.state.messages = manager.buildSessionContext().messages;
  const hostTools = Object.values(baseTools);
  // Explicit initial names bypass the SDK's own transcript restore, so carry
  // over the deferred tools this branch already loaded.
  const initialActive = [
    ...hostTools.filter(tool => !isDeferred(tool)).map(tool => tool.name),
    ...(hostTools.some(isDeferred) ? [PI_TOOL_SEARCH_TOOL_NAME] : []),
    ...(resumed ? loadedDeferredTools(ai, manager, hostTools) : []),
  ];
  const extensionRunnerRef: { current?: any } = {};
  const session = new sdk.AgentSession({
    agent, cwd: deps.cwd, modelRuntime, sessionManager: manager, settingsManager: settings,
    resourceLoader: loader, baseToolsOverride: {},
    initialActiveToolNames: initialActive, extensionRunnerRef,
  });
  await session.bindExtensions({
    uiContext: ui.context, mode: PI_EXTENSION_UI_MODE,
    onError: (error: any) => log.warn('chat', `Pi extension ${error?.extensionPath} failed in ${error?.event}: ${error?.error}`),
  });
  const listeners = new Set<(event: any) => void>();
  // SDK can compact/retry after agent_end. The durable turn ends only once
  // prompt() settles, after all SDK-owned work and transcript writes finish.
  let endEvent: any;
  session.subscribe((event: any) => {
    if (event.type === 'agent_end') { endEvent = event; return; }
    const mapped = event.type === 'auto_compaction_start' ? { ...event, type: 'compaction_start' }
      : event.type === 'auto_compaction_end' ? { ...event, type: 'compaction_end' } : event;
    for (const listener of listeners) listener(mapped);
  });
  return {
    get state() { return agent.state; },
    set streamFunction(stream: any) { agent.streamFunction = stream; },
    async configureAuth(provider: string, apiKey: string | null) {
      // SDK preflight requires a configured auth entry even for a custom
      // stream. Bedrock's actual AWS chain stays in Michi's stream adapter.
      await modelRuntime.setRuntimeApiKey(provider, apiKey ?? 'michi-host-managed-auth');
    },
    subscribe(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt(text: string, images?: any[]) {
      endEvent = undefined;
      try { await session.prompt(text, { images, expandPromptTemplates: false }); }
      finally { approvals.clear(); }
      // An input extension may handle the prompt without starting an Agent.
      // Successful SDK settlement still closes the owning durable turn.
      for (const listener of listeners) listener(endEvent ?? { type: 'agent_end', messages: [] });
    },
    steer(message: any) {
      return session.steer(message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n'));
    },
    abort() { void session.abort(); },
    /** Manual compaction; resolves with the SDK's CompactionResult once the transcript records it. */
    compact(instructions?: string) { return session.compact(instructions); },
    checkpoint(messages: ChatMessage[]) {
      const temporary = `${checkpoint}.tmp`;
      const state: HostCheckpoint = { hash: historyHash(messages), count: messages.length, leafId: manager.getLeafId() };
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(temporary, checkpoint);
    },
    async dispose() {
      try {
        // dispose() only invalidates contexts; explicitly deliver shutdown
        // before resources are retired, including extension cleanup handlers.
        const runner = extensionRunnerRef.current;
        if (runner?.hasHandlers('session_shutdown')) await runner.emit({ type: 'session_shutdown', reason: 'exit' });
      } finally { session.dispose(); }
    },
    async updateTools(tools: any[]) {
      // Failed MCP setup may add tools on a later turn. Refresh the SDK's
      // registry as well as the Agent's current loadout.
      const entries = Object.fromEntries(tools.map((tool: any) => [tool.name, tool]));
      // registerTool refreshes the session-local registry, including same-name
      // schema/handler changes, without reload() resetting global providers.
      const previouslyRegistered = new Set(Object.keys(baseTools));
      const active = new Set<string>(session.getActiveToolNames());
      for (const name of previouslyRegistered) if (!(name in entries)) active.delete(name);
      for (const tool of tools) {
        hostExtension.registerTool(guardTool(tool));
        // Refreshing an existing definition must preserve an extension's
        // deliberate tool hiding. Newly connected direct MCP tools become
        // active; deferred ones wait for tool_search.
        if (!previouslyRegistered.has(tool.name) && !isDeferred(tool)) active.add(tool.name);
      }
      if (tools.some(isDeferred)) active.add(PI_TOOL_SEARCH_TOOL_NAME);
      else active.delete(PI_TOOL_SEARCH_TOOL_NAME);
      for (const name of Object.keys(baseTools)) delete baseTools[name];
      Object.assign(baseTools, entries);
      session.setActiveToolsByName([...active]);
    },
  };
}
