import { finalizeTurnContent } from 'michi-shared';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { PiSessionDeps } from './PiSession';
import { getMichiDataDir } from '../../services/dataDir';
import { loadPiAi, loadPiBundle } from './piAi';
import type { ChatMessage } from '../types';

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

function historyHash(messages: Array<{ role: string; content: any }>): string {
  return createHash('sha256').update(JSON.stringify(messages.map(message => {
    const text = typeof message.content === 'string' ? message.content : message.content[0]?.text ?? '';
    return { role: message.role, content: message.role === 'assistant' ? finalizeTurnContent(text) : text.trim() };
  }))).digest('hex');
}

/** Rollback runs invalidate the native view before another model request. */
export function invalidatePiSdkTranscript(id: string, deps: PiSessionDeps): void {
  const directory = piSdkSessionDirectory(id, deps);
  if (fs.existsSync(directory)) fs.writeFileSync(path.join(directory, 'invalidated'), 'agent-core');
}

/**
 * A full SDK lifecycle around Michi's Agent. No default discovery, auth files,
 * provider config, built-in shell tools, or user-global packages are inherited.
 * Extension factories below are an explicit host-owned lifecycle entry point.
 */
export async function createPiSdkHarness(id: string, deps: PiSessionDeps, core: any, options: any): Promise<any> {
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
  const agent = new core.Agent(options);
  let hostExtension: any;
  const loader = new sdk.DefaultResourceLoader({
    cwd: deps.cwd, agentDir: directory, settingsManager: settings,
    noExtensions: true, disabledBuiltinExtensions: ['mcp'], noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: options.initialState.systemPrompt,
    extensionFactories: [(pi: any) => {
      hostExtension = pi;
      for (const tool of options.initialState.tools) pi.registerTool(tool);
      pi.on('tool_call', async (event: any) => options.beforeToolCall?.({
        toolCall: { name: event.toolName, id: event.toolCallId }, args: event.input,
      }, agent.signal));
      pi.on('tool_result', async (event: any) => options.afterToolCall?.({
        toolCall: { name: event.toolName, id: event.toolCallId }, args: event.input,
        result: { content: event.content, details: event.details }, isError: event.isError,
      }, agent.signal));
    }, ...(deps.sdkExtensionFactories ?? [])],
  });
  await loader.reload();
  const checkpoint = path.join(directory, 'host-history.sha256');
  const invalidated = path.join(directory, 'invalidated');
  const matchesHostHistory = deps.restoreNative && fs.existsSync(checkpoint)
    && fs.readFileSync(checkpoint, 'utf8') === historyHash(deps.initialMessages ?? []);
  const hasTranscript = fs.existsSync(transcript) && matchesHostHistory && !fs.existsSync(invalidated);
  if (fs.existsSync(transcript) && !hasTranscript) {
    // SQLite replay/cut/rollback is authoritative. Retain the original native
    // tree for recovery; never silently resume an older view or erase it.
    fs.renameSync(transcript, path.join(directory, `retired-${Date.now()}-${process.hrtime.bigint()}.jsonl`));
  }
  fs.rmSync(invalidated, { force: true });
  const manager = hasTranscript
    ? sdk.SessionManager.open(transcript, directory, deps.cwd)
    : sdk.SessionManager.create(deps.cwd, directory);
  if (!hasTranscript) {
    manager.setSessionFile(transcript);
    for (const message of options.initialState.messages ?? []) manager.appendMessage(message);
  }
  agent.state.messages = manager.buildSessionContext().messages;
  const baseTools: Record<string, any> = Object.fromEntries(options.initialState.tools.map((tool: any) => [tool.name, tool]));
  const extensionRunnerRef: { current?: any } = {};
  const session = new sdk.AgentSession({
    agent, cwd: deps.cwd, modelRuntime, sessionManager: manager, settingsManager: settings,
    resourceLoader: loader, baseToolsOverride: {},
    initialActiveToolNames: Object.keys(baseTools), extensionRunnerRef,
  });
  await session.bindExtensions({});
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
      await session.prompt(text, { images, expandPromptTemplates: false });
      // An input extension may handle the prompt without starting an Agent.
      // Successful SDK settlement still closes the owning durable turn.
      for (const listener of listeners) listener(endEvent ?? { type: 'agent_end', messages: [] });
    },
    steer(message: any) {
      return session.steer(message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n'));
    },
    abort() { void session.abort(); },
    checkpoint(messages: ChatMessage[]) {
      const temporary = `${checkpoint}.tmp`;
      fs.writeFileSync(temporary, historyHash(messages), { mode: 0o600 });
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
        hostExtension.registerTool(tool);
        // Refreshing an existing definition must preserve an extension's
        // deliberate tool hiding. Newly connected host MCP tools become active.
        if (!previouslyRegistered.has(tool.name)) active.add(tool.name);
      }
      for (const name of Object.keys(baseTools)) delete baseTools[name];
      Object.assign(baseTools, entries);
      session.setActiveToolsByName([...active]);
    },
  };
}
