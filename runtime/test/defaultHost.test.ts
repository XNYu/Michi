import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import type { AgentSessionState } from 'michi-shared';
import type { NormalizedEvent } from '../src/contract/events';
import type { AgentSession } from '../src/contract/types';
import {
  RuntimeHostConfigError,
  SessionProfileUnsupportedError,
  ownerMode,
  type RuntimeHost,
  type RuntimeLogLevel,
} from '../src/contract/host';
import { assertHostPorts, createDefaultHost } from '../src/core/defaultHost';
import { claudeSpawnPolicy } from '../src/adapters/claude/claudeRestrictedProfile';
import { codexThreadSandbox } from '../src/adapters/codex/codexRestrictedProfile';
import * as root from '../src/index';
import { headless, interactive } from './owners';

const chat = interactive('n1');
const run = headless('a1');

function plain(id: string, extra: Partial<AgentSession> = {}): AgentSession {
  return {
    id, runtimeId: 'pi', getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() {}, cancel: () => {}, ...extra,
  };
}

function recordingSink() {
  const lines: Array<{ level: RuntimeLogLevel; args: unknown[] }> = [];
  const at = (level: RuntimeLogLevel) => (...args: unknown[]) => { lines.push({ level, args }); };
  return { lines, sink: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') } };
}

async function* eventsOf(items: NormalizedEvent[], onDone: () => void): AsyncIterableIterator<NormalizedEvent> {
  try {
    for (const item of items) yield item;
  } finally {
    onDone();
  }
}

describe('ownerMode', () => {
  it('maps chats to interactive and Agent Runs to headless', () => {
    assert.equal(ownerMode(chat), 'interactive');
    assert.equal(ownerMode(run), 'headless');
  });
});

describe('createDefaultHost', () => {
  it('is exported from the package root', () => {
    assert.equal(root.createDefaultHost, createDefaultHost);
    assert.equal(root.assertHostPorts, assertHostPorts);
    assert.equal(root.ownerMode, ownerMode);
  });

  it('config returns the overrides, or empty values', async () => {
    const bare = createDefaultHost().config;
    assert.equal(bare.defaultModel('claude'), '');
    assert.equal(bare.defaultReasoning('codex', 'u1'), undefined);
    assert.deepEqual(bare.titleModel('kiro'), { model: null, timeoutMs: 15_000 });
    assert.equal(bare.features.workflows('kiro', 'u1'), false);
    assert.equal(bare.dataDir(), path.join(os.homedir(), '.agent-runtime'));
    const off = bare.onDefaultModelChanged(() => assert.fail('the defaults never change'));
    assert.equal(typeof off, 'function');
    off();

    const config = createDefaultHost({
      defaultModels: { claude: 'sonnet' },
      defaultReasoning: { codex: 'high' },
      titleModels: { kiro: { model: 'luna', timeoutMs: 5 } },
      workflows: (runtimeId, userId) => runtimeId === 'kiro' && userId === 'u1',
      dataDir: '/data',
    }).config;
    assert.equal(config.defaultModel('claude'), 'sonnet');
    assert.equal(config.defaultReasoning('codex'), 'high');
    assert.deepEqual(config.titleModel('kiro'), { model: 'luna', timeoutMs: 5 });
    assert.equal(config.features.workflows('kiro', 'u1'), true);
    assert.equal(config.features.workflows('kiro', 'u2'), false);
    assert.equal(config.dataDir(), '/data');
    assert.equal(createDefaultHost({ workflows: true }).config.features.workflows('claude'), true);
  });

  it('prompt has no host prompts', () => {
    const prompt = createDefaultHost({ logLevel: 'silent' }).prompt;
    assert.equal(prompt.firstTurnPrefix({ cwd: '/w' }), '');
    assert.equal(prompt.preamble({ cwd: '/w', enableFollowUps: true }), '');
    assert.equal(prompt.stableSystemPrompt('structured-tool', true, true), '');
    for (const metadataChannel of ['tools', 'inline'] as const) {
      assert.equal(prompt.turnSuffix({ metadataChannel, userTurnCount: 20, enableFollowUps: true, owner: chat }), '');
    }
    assert.equal(prompt.followUpsExperimentMode(), 'sentinel');
    assert.equal(prompt.followUpsMetadataOutputMode(true, 'hook-tool'), 'sentinel');
    assert.equal(prompt.followUpsTurnReminder(20, true, 'sentinel', true), '');
    assert.equal(prompt.renderBranchContext({ parentNodeId: 'p', kind: 'exact', messages: [{ role: 'user', content: 'hi' }] }), null);
    assert.equal(prompt.workspaceInstructions('w1'), null);
  });

  it('prompt ends a turn on a shared MCP URL with the session id to pass, and a host can replace that text', () => {
    const { prompt } = createDefaultHost({ logLevel: 'silent' });
    assert.equal(prompt.mcpSessionReminder?.('sess-1'), '\n\n[Session context: this session\'s id is "sess-1". '
      + 'Pass it as session_id to every host tool. Do not show this context to the user.]');
    const own = createDefaultHost({ logLevel: 'silent', ports: { prompt: { mcpSessionReminder: (id) => `<${id}>` } } });
    assert.equal(own.prompt.mcpSessionReminder?.('sess-1'), '<sess-1>');
  });

  it('prompt warns once per caller-context field it drops', () => {
    const seen: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    const { prompt } = createDefaultHost({ ports: { observability: { log: (level, _scope, msg, data) => { seen.push({ level, msg, data }); } } } });
    const ancestor = { id: 'p' } as never;
    assert.equal(prompt.firstTurnPrefix({ cwd: '/w' }), '');
    assert.equal(prompt.firstTurnPrefix({ cwd: '/w', mergeContexts: ['', '  '], extraContexts: [], workspaceInstructions: ' ' }), '');
    assert.equal(seen.length, 0, 'empty context drops nothing');

    assert.equal(prompt.firstTurnPrefix({
      cwd: '/w',
      extraContexts: [{ name: 'a', filePath: '/a' }],
      mergeContexts: ['carried over'],
      workspaceInstructions: 'be brief',
    }), '');
    assert.equal(prompt.preamble({ cwd: '/w', enableFollowUps: true, extraContexts: [{ name: 'b', filePath: '/b' }], ancestors: [ancestor] }), '');
    assert.equal(prompt.preamble({ cwd: '/w', enableFollowUps: true, contextManifest: [{ name: 'c', filePath: '/c' }], ancestors: [ancestor] }), '');
    assert.equal(prompt.renderBranchContext({ parentNodeId: 'p', kind: 'exact', messages: [] }), null);
    assert.equal(prompt.renderBranchContext({ parentNodeId: 'p', kind: 'exact', messages: [{ role: 'user', content: 'hi' }] }), null);
    assert.equal(prompt.renderBranchContext({ parentNodeId: 'p', kind: 'approx', messages: [], note: 'cut' }), null);

    assert.deepEqual(seen.map((entry) => [entry.level, entry.data?.fields]), [
      ['warn', ['extraContexts', 'mergeContexts', 'workspaceInstructions']],
      ['warn', ['ancestors']],
      ['warn', ['contextManifest']],
      ['warn', ['branchContext']],
    ]);
    assert.match(seen[0].msg, /renders no caller context/);
  });

  it('prompt hands out an inert turn-metadata tracker', () => {
    const tracker = createDefaultHost().prompt.turnMetadata('hook-tool');
    tracker.begin();
    assert.equal(tracker.validationActive, false);
    assert.equal(tracker.acceptsFollowUps(true), false);
    assert.equal(tracker.setFollowUps(['a', 'b', 'c'], true), null);
    assert.equal(tracker.setOverview('did things'), null);
    tracker.observeChunk('[FOLLOW-UP 3/3: x]', true);
    assert.deepEqual(tracker.validate(true), { status: 'inactive', missingTools: [], response: {} });
    assert.equal(tracker.suppressOutput('chunk'), false);
    assert.equal(tracker.completeOutputBoundary(), false);
    assert.deepEqual(tracker.finish(), { chunks: 0, thoughts: 0 });
  });

  it('profile leaves unflagged sessions unrestricted', () => {
    const profile = createDefaultHost().profile;
    const allowed = { allowedToolNames: ['read'] };
    assert.equal(profile.isRestricted(allowed), false);
    assert.equal(profile.isRestricted(undefined), false);
    assert.equal(profile.isRestrictedWorkspace('w1'), false);
    assert.equal(profile.composeFirstTurnPrefix('context', 'bootstrap', allowed), 'context\n\nbootstrap');
    assert.equal(profile.composeFirstTurnPrefix('', undefined, undefined), '');
    const error = profile.unsupportedError('kiro');
    assert.ok(error instanceof SessionProfileUnsupportedError);
    assert.equal((error as SessionProfileUnsupportedError).runtimeId, 'kiro');
    assert.deepEqual(Object.keys(profile).sort(), ['composeFirstTurnPrefix', 'isRestricted', 'isRestrictedWorkspace', 'unsupportedError']);
  });

  it('profile flags a session whose tool profile carries the restricted flag', () => {
    const profile = createDefaultHost().profile;
    const restricted = { allowedToolNames: ['list_threads'], restricted: true };
    assert.equal(profile.isRestricted(restricted), true);
    assert.ok(profile.unsupportedError('kiro') instanceof SessionProfileUnsupportedError);
  });

  it('bindings read back what was written', () => {
    const bindings = createDefaultHost({
      nodes: [{ id: 'n1', workspace_id: 'w1', kind: 'chat', status: 'idle', runtime_engine: 'v3' }],
      workspaces: [{ id: 'w1', cwd: '/w', owner_user_id: null }],
      edges: [
        { id: 'e1', workspace_id: 'w1', source_node_id: 'n1', target_node_id: 'n2', kind: 'branch', anchor_message_id: 'm1' },
        { id: 'e2', workspace_id: 'w2', source_node_id: 'x', target_node_id: 'y', kind: 'branch' },
      ],
    }).bindings;
    assert.equal(bindings.nodeBinding('missing'), null);
    assert.equal(bindings.nodeBinding('n1')?.runtime_engine, 'v3');
    assert.deepEqual(bindings.workspace('w1'), { id: 'w1', cwd: '/w', owner_user_id: null });
    assert.equal(bindings.workspace('w2'), null);
    assert.deepEqual(bindings.edges('w1').map((edge) => edge.id), ['e1']);

    bindings.recordNativeSessionId(chat, 'native-1');
    const node = bindings.nodeBinding('n1');
    assert.equal(node?.external_session_id, 'native-1');
    assert.equal(node?.acp_session_id, 'native-1');
    assert.equal(node?.workspace_id, 'w1');

    bindings.recordNativeSessionId(interactive('fresh'), 'native-2');
    assert.equal(bindings.nodeBinding('fresh')?.external_session_id, 'native-2');

    // A headless owner has no durable binding: the write fails closed.
    assert.throws(() => bindings.recordNativeSessionId(run, 'native-3'), /Only an interactive owner records a native session id/);
    assert.equal(bindings.nodeBinding(run.key), null);
  });

  it('Kiro fork anchors are kept only for a node bound to that session', () => {
    const { bindings } = createDefaultHost();
    const anchors = bindings.forkAnchors;
    const save = (nativeSessionId: string, assistantMessageId: string) => anchors.saveKiroForkAnchor({
      nodeId: 'n1', nativeSessionId, engine: 'v3', assistantMessageId, userMessageId: `u-${assistantMessageId}`, anchor: { logIndex: 4 },
    });
    save('s1', 'a0');
    assert.equal(anchors.readKiroForkAnchor('n1', 's1', 'v3', 'a0'), null, 'no binding yet');
    bindings.recordNativeSessionId(chat, 's1');
    save('s1', 'a1');
    save('s2', 'a2');
    assert.deepEqual(anchors.readKiroForkAnchor('n1', 's1', 'v3', 'a1'), { logIndex: 4 });
    assert.deepEqual(anchors.readKiroForkAnchor('n1', 's1', 'v3', 'u-a1'), { logIndex: 4 });
    assert.equal(anchors.readKiroForkAnchor('n1', 's1', 'v2', 'a1'), null);
    assert.equal(anchors.readKiroForkAnchor('n1', 's2', 'v3', 'a2'), null, 'saved against another session');
  });

  it('Claude fork anchors are read back only for a live, bound chat the caller owns', () => {
    const { bindings } = createDefaultHost({
      nodes: [
        { id: 'n1', workspace_id: 'w1', kind: 'chat', status: 'idle', external_session_id: 's1' },
        { id: 'n2', workspace_id: 'w2', kind: 'chat', status: 'idle', acp_session_id: 's2' },
        { id: 'n3', workspace_id: 'w3', kind: 'chat', status: 'idle', external_session_id: 's3' },
        { id: 'gone', workspace_id: 'w1', kind: 'chat', status: 'idle', external_session_id: 's4', deleted_at: 1 },
        { id: 'doc', workspace_id: 'w1', kind: 'document', status: 'idle', external_session_id: 's5' },
      ],
      workspaces: [
        { id: 'w1', owner_user_id: null },
        { id: 'w2', owner_user_id: 'u2' },
        { id: 'w3', owner_user_id: null, archived_at: 5 },
      ],
    });
    const anchors = bindings.forkAnchors;
    const save = (nodeId: string, nativeSessionId: string) => anchors.saveClaudeForkAnchor({
      nodeId, nativeSessionId, assistantMessageId: 'a1', nativeMessageId: `na-${nodeId}`, userMessageId: 'u1', nativeUserMessageId: `nu-${nodeId}`,
    });
    const read = (nodeId: string, nativeSessionId: string, extra: { workspaceId?: string | null; ownerUserId?: string | null; messageId?: string } = {}) =>
      anchors.readClaudeForkAnchor({ nodeId, nativeSessionId, messageId: extra.messageId ?? 'a1', workspaceId: extra.workspaceId, ownerUserId: extra.ownerUserId });

    for (const [nodeId, sid] of [['n1', 's1'], ['n2', 's2'], ['n3', 's3'], ['gone', 's4'], ['doc', 's5']]) save(nodeId, sid);
    save('n1', 'stale');
    assert.equal(read('n1', 's1'), 'na-n1');
    assert.equal(read('n1', 's1', { messageId: 'u1' }), 'nu-n1');
    assert.equal(read('n1', 's1', { workspaceId: 'w1' }), 'na-n1');
    assert.equal(read('n1', 's1', { workspaceId: 'w2' }), null, 'another workspace');
    assert.equal(read('n1', 's1', { ownerUserId: 'u1' }), null, 'an unowned workspace belongs to the local principal');
    assert.equal(read('n1', 'stale'), null, 'never saved: not the bound session');
    assert.equal(read('n2', 's2', { ownerUserId: 'u2' }), 'na-n2', 'acp_session_id binds when there is no external id');
    assert.equal(read('n2', 's2', { ownerUserId: 'u1' }), null, 'owned by another user');
    assert.equal(read('n2', 's2'), null, 'the local principal does not own u2\'s workspace');
    assert.equal(read('n3', 's3'), null, 'archived workspace');
    assert.equal(read('gone', 's4'), null, 'deleted node');
    assert.equal(read('doc', 's5'), null, 'not a chat');

    bindings.recordNativeSessionId(chat, 's1-next');
    assert.equal(read('n1', 's1'), null, 'the chat moved to another native session');
  });

  it('fork anchors check bindings through an overridden nodeBinding', () => {
    const node = { id: 'n1', workspace_id: 'w1', kind: 'chat', status: 'idle', acp_session_id: 's1', external_session_id: 's1' };
    const { bindings } = createDefaultHost({
      workspaces: [{ id: 'w1', owner_user_id: null }],
      ports: { bindings: { nodeBinding: (id) => id === 'n1' ? node : null } },
    });
    bindings.forkAnchors.saveKiroForkAnchor({ nodeId: 'n1', nativeSessionId: 's1', engine: 'v3', assistantMessageId: 'a1', anchor: { messageId: 'k1' } });
    assert.deepEqual(bindings.forkAnchors.readKiroForkAnchor('n1', 's1', 'v3', 'a1'), { messageId: 'k1' });
    bindings.forkAnchors.saveClaudeForkAnchor({ nodeId: 'n1', nativeSessionId: 's1', assistantMessageId: 'a1', nativeMessageId: 'na1' });
    assert.equal(bindings.forkAnchors.readClaudeForkAnchor({ nodeId: 'n1', nativeSessionId: 's1', messageId: 'a1' }), 'na1');
  });

  it('crew memory defaults to persistent and pins onto the node', () => {
    const { bindings } = createDefaultHost();
    assert.equal(bindings.crewMemory?.defaultMode('u1'), 'persistent');
    assert.equal(bindings.crewMemory?.defaultMode(null), 'persistent');
    bindings.crewMemory?.pin('n1', 'incognito');
    assert.equal(bindings.nodeBinding('n1')?.crew_memory_mode, 'incognito');
  });

  it('crew memory refuses an invalid mode, as Michi does', () => {
    const { bindings } = createDefaultHost();
    assert.throws(() => bindings.crewMemory?.pin('n1', 'forever' as never), /^Error: Invalid Crew memory mode$/);
    assert.equal(bindings.nodeBinding('n1'), null);
  });

  it('sessions register, find and drop live sessions', () => {
    const { sessions } = createDefaultHost();
    const first = plain('s1');
    const second = plain('s1');
    assert.equal(sessions.getSession('s1'), undefined);
    sessions.registerSession(first, 'u1');
    assert.equal(sessions.getSession('s1'), first);
    // Registering an id again replaces its entry.
    sessions.registerSession(second, null, run);
    assert.equal(sessions.getSession('s1'), second);
    sessions.dropSession('s1');
    assert.equal(sessions.getSession('s1'), undefined);
    sessions.dropSession('s1');
  });

  it('sessions keep no history: ancestors are the live chain, oldest first', () => {
    const { sessions } = createDefaultHost();
    const root = plain('root');
    const middle = plain('middle', { parentChatId: 'root' });
    const leaf = plain('leaf', { parentChatId: 'middle' });
    for (const session of [root, middle, leaf]) sessions.registerSession(session);
    sessions.ensureAncestorChainLoaded('leaf');
    assert.deepEqual(sessions.getAncestors('leaf'), [root, middle]);
    assert.deepEqual(sessions.getAncestors('root'), []);
    assert.deepEqual(sessions.getAncestors('missing'), []);

    // Nothing loads a dropped ancestor back: the chain ends below it.
    sessions.dropSession('root');
    sessions.ensureAncestorChainLoaded('leaf');
    assert.equal(sessions.getSession('root'), undefined);
    assert.deepEqual(sessions.getAncestors('leaf'), [middle]);

    // A cycle ends the walk instead of looping.
    sessions.registerSession(plain('a', { parentChatId: 'b' }));
    sessions.registerSession(plain('b', { parentChatId: 'a' }));
    assert.deepEqual(sessions.getAncestors('a').map((session) => session.id), ['a', 'b']);
  });

  it('sessions report state changes of interactive sessions to onSessionStateChanged', () => {
    const changes: Array<{ id: string; ownerUserId: string | null; state: AgentSessionState }> = [];
    const { sessions } = createDefaultHost({
      ports: { onSessionStateChanged: (session, ownerUserId, state) => { changes.push({ id: session.id, ownerUserId, state }); } },
    });
    let notify: (() => void) | undefined;
    const session = plain('s1', {
      getSessionState: () => ({ runtimeId: 'pi', modelId: 'm1' }),
      onSessionState: (listener) => { notify = listener; return () => { notify = undefined; }; },
    });
    const change = { id: 's1', ownerUserId: 'u1', state: { runtimeId: 'pi', modelId: 'm1' } };
    // Registering reports the current state, then every change follows.
    sessions.registerSession(session, 'u1');
    assert.deepEqual(changes, [change]);
    notify?.();
    assert.deepEqual(changes, [change, change]);
    sessions.dropSession('s1');
    assert.equal(notify, undefined);
    // A headless owner's session is not tracked.
    sessions.registerSession(session, 'u1', run);
    assert.equal(changes.length, 2);
  });

  it('permissions ask until a grant, then allow', () => {
    const permissions = createDefaultHost().permissions;
    assert.equal(permissions.mode(chat, 'u1'), 'ask');
    assert.equal(permissions.mode(undefined), 'ask');
    assert.equal(permissions.resolveOwnerUserId(chat, undefined), null);
    assert.equal(permissions.resolveOwnerUserId(chat, 'u1'), 'u1');
    assert.equal(permissions.resetToken, undefined);

    assert.equal(permissions.decide({ owner: chat, ownerUserId: 'u1', toolName: 'bash' }), 'ask');
    permissions.grant({ owner: chat, ownerUserId: 'u1', toolName: 'bash' });
    assert.equal(permissions.decide({ owner: chat, ownerUserId: 'u1', toolName: 'bash', nativeRequest: true }), 'allow');
    // Grants belong to one owner, user and tool.
    assert.equal(permissions.decide({ owner: chat, ownerUserId: 'u2', toolName: 'bash' }), 'ask');
    assert.equal(permissions.decide({ owner: chat, ownerUserId: 'u1', toolName: 'edit' }), 'ask');
    assert.equal(permissions.decide({ owner: run, ownerUserId: 'u1', toolName: 'bash' }), 'ask');
    // A turn already resolved to a non-Ask mode allows.
    assert.equal(permissions.decide({ owner: chat, ownerUserId: 'u1', toolName: 'edit', mode: 'trust' }), 'allow');
  });

  it('principal falls back to the local principal', () => {
    const principal = createDefaultHost().principal;
    assert.equal(principal.resolve(undefined), 'local');
    assert.equal(principal.resolve(null), 'local');
    assert.equal(principal.resolve('u1'), 'u1');
    assert.equal(principal.workspaceOwnerMatches('u1', 'u1'), true);
    assert.equal(principal.workspaceOwnerMatches(null, 'local'), true);
    assert.equal(principal.workspaceOwnerMatches(null, 'u1'), false);
    assert.equal(principal.workspaceOwnerMatches('u2', 'u1'), false);

    const named = createDefaultHost({ principal: 'me' }).principal;
    assert.equal(named.resolve(undefined), 'me');
    assert.equal(named.workspaceOwnerMatches(null, 'me'), true);
    assert.equal(named.workspaceOwnerMatches(null, 'local'), false);
  });

  it('principal does not enforce per-user ownership by default', () => {
    assert.equal(createDefaultHost().principal.enforceUserOwnership(), false);
    const enforced = createDefaultHost({ ports: { principal: { enforceUserOwnership: () => true } } }).principal;
    assert.equal(enforced.enforceUserOwnership(), true);
    assert.equal(enforced.resolve(undefined), 'local');
  });

  it('observability filters by level', () => {
    const { lines, sink } = recordingSink();
    const { log } = createDefaultHost({ logLevel: 'warn', logSink: sink }).observability;
    log('debug', 'chat', 'hidden');
    log('info', 'chat', 'hidden');
    log('warn', 'acp', 'shown', { pid: 1 });
    log('error', 'mcp', 'also shown');
    assert.deepEqual(lines, [
      { level: 'warn', args: ['[acp] shown', { pid: 1 }] },
      { level: 'error', args: ['[mcp] also shown'] },
    ]);

    const defaults = recordingSink();
    createDefaultHost({ logSink: defaults.sink }).observability.log('debug', 'chat', 'hidden by default');
    createDefaultHost({ logSink: defaults.sink }).observability.log('info', 'chat', 'shown by default');
    assert.deepEqual(defaults.lines.map((line) => line.level), ['info']);

    const silent = recordingSink();
    createDefaultHost({ logLevel: 'silent', logSink: silent.sink }).observability.log('error', 'chat', 'nothing');
    assert.equal(silent.lines.length, 0);
  });

  it('observability has a working clock and no optional sinks', () => {
    const observability = createDefaultHost().observability;
    const t0 = observability.perf.now();
    assert.ok(Number.isFinite(t0));
    observability.perf.mark('stage');
    observability.perf.measure('stage', t0, { a: 1 });
    assert.equal(observability.startupMark, undefined);
    assert.equal(observability.streamProbe, undefined);
    assert.equal(observability.childStderr, undefined);
  });

  it('title generates no titles and has no host text', () => {
    const { title } = createDefaultHost();
    for (const runtimeId of ['kiro', 'crew', 'codex', 'claude']) assert.equal(title.enabled(runtimeId), false);
    assert.equal(title.prompt('hello', 'context'), '');
    assert.deepEqual(Object.keys(title).sort(), ['enabled', 'prompt']);
  });

  it('background turns are cancelled and drained', async () => {
    const { backgroundTurns } = createDefaultHost({ logLevel: 'silent' });
    let cancelled = false;
    let drained!: () => void;
    const done = new Promise<void>((resolve) => { drained = resolve; });
    backgroundTurns?.consume({
      chatId: 'n1',
      owner: chat,
      cancel: () => { cancelled = true; },
      events: eventsOf([{ kind: 'chunk', text: 'a' }, { kind: 'chunk', text: 'b' }], () => drained()),
    });
    await done;
    assert.equal(cancelled, true);
    assert.equal(backgroundTurns?.isActive('n1'), false);
    assert.equal(backgroundTurns?.isOwnerTurnActive('n1'), false);
    assert.equal(backgroundTurns?.hasPendingSelfTurn('n1'), false);
  });

  it('background turns are drained even when cancel throws', async () => {
    const { backgroundTurns } = createDefaultHost({ logLevel: 'silent' });
    let drained!: () => void;
    const done = new Promise<void>((resolve) => { drained = resolve; });
    backgroundTurns?.consume({
      chatId: 'n1',
      owner: chat,
      cancel: () => { throw new Error('no process'); },
      events: eventsOf([{ kind: 'chunk', text: 'a' }], () => drained()),
    });
    await done;
  });

  it('workflow runs are not tracked and approvals fall back', () => {
    const workflows = createDefaultHost().workflows!;
    const context = { ownerUserId: 'u1', workspaceId: 'w1', owner: chat };
    assert.equal(workflows.update(context, 'kiro', 'wf1', (current) => current), null);
    assert.equal(workflows.updateKnown('kiro', 'wf1', (current) => current), null);
    workflows.registerControls('u1', 'kiro', 'wf1', {});
    assert.equal(workflows.requestApproval('u1', 'kiro', 'wf1', { id: 'ap1' } as never, () => assert.fail('never resolved')), false);
    workflows.withdrawApproval('u1', 'kiro', 'wf1', 'ap1');
    workflows.releaseControls('u1', 'kiro', 'wf1', 'gone');
  });

  it('background subagents are accepted and dropped', () => {
    const sink = createDefaultHost().backgroundSubagents!;
    const context = { ownerUserId: 'u1', workspaceId: 'w1', owner: chat };
    sink.report(context, 'claude:1', ['s1']);
    sink.end(context, 'claude:1', [{ sessionId: 's1', outcome: 'stopped' } as never]);
  });

  it('leaves interaction and session-state persistence to the host', () => {
    const host = createDefaultHost();
    assert.equal(host.interaction, undefined);
    assert.equal(host.onSessionStateChanged, undefined);
  });

});

describe('createDefaultHost overrides', () => {
  it('merges overrides method by method', () => {
    const host = createDefaultHost({ ports: { title: { prompt: (userText) => `title for ${userText}` } } });
    assert.equal(host.title.prompt('x'), 'title for x');
    assert.equal(host.config.defaultModel('claude'), '');
    assert.equal(typeof host.permissions.decide, 'function');
  });

  it('decide follows an overridden mode', () => {
    const host = createDefaultHost({ ports: { permissions: { mode: () => 'trust' } } });
    assert.equal(host.permissions.mode(chat), 'trust');
    assert.equal(host.permissions.decide({ owner: chat, ownerUserId: 'u1', toolName: 'bash' }), 'allow');
  });

  it('grants follow an overridden owner-user resolution', () => {
    const host = createDefaultHost({ ports: { permissions: { resolveOwnerUserId: () => 'workspace-owner' } } });
    host.permissions.grant({ owner: chat, ownerUserId: null, toolName: 'bash' });
    // Both calls resolve to the same owner user, whatever the caller passed.
    assert.equal(host.permissions.decide({ owner: chat, ownerUserId: 'someone-else', toolName: 'bash' }), 'allow');
  });

  it('takes the permission mode from options', () => {
    assert.equal(createDefaultHost({ permissionMode: 'trust' }).permissions.decide({ owner: chat, ownerUserId: null, toolName: 'bash' }), 'allow');
    const byOwner = createDefaultHost({ permissionMode: (owner) => owner?.mode === 'headless' ? 'yolo' : 'ask' }).permissions;
    assert.equal(byOwner.mode(run), 'yolo');
    assert.equal(byOwner.decide({ owner: run, ownerUserId: null, toolName: 'bash' }), 'allow');
    assert.equal(byOwner.decide({ owner: chat, ownerUserId: null, toolName: 'bash' }), 'ask');
  });

  it('background turns log through an overridden observability', async () => {
    const seen: Array<[string, string, string]> = [];
    const host = createDefaultHost({ ports: { observability: { log: (level, scope, msg) => { seen.push([level, scope, msg]); } } } });
    let drained!: () => void;
    const done = new Promise<void>((resolve) => { drained = resolve; });
    host.backgroundTurns?.consume({ chatId: 'n1', owner: chat, events: eventsOf([], () => drained()) });
    await done;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, [['debug', 'runtime', 'background turn discarded: the host has no turn consumer']]);
    assert.equal(typeof host.observability.perf.now(), 'number');
  });

  it('the restricted lockdown follows an overridden isRestricted', () => {
    // The adapters lock a session down by the merged host's verdict, not by the flag itself.
    const everyChat = createDefaultHost({ ports: { profile: { isRestricted: () => true } } }).profile;
    assert.equal(codexThreadSandbox(everyChat.isRestricted(undefined)), 'read-only');
    assert.equal(claudeSpawnPolicy(everyChat.isRestricted(undefined), { ownerMode: 'interactive', permissionMode: 'yolo', toolProfile: undefined }).restrictedMode, true);

    const none = createDefaultHost({ ports: { profile: { isRestricted: () => false } } }).profile;
    const flagged = { restricted: true };
    assert.equal(codexThreadSandbox(none.isRestricted(flagged)), 'workspace-write');
    assert.deepEqual(claudeSpawnPolicy(none.isRestricted(flagged), { ownerMode: 'interactive', permissionMode: 'ask', toolProfile: flagged }), { permissionMode: 'default' });
  });

  it('keeps one store behind the bindings methods that are not overridden', () => {
    const workspace = (id: string) => ({ id, cwd: `/ws/${id}`, owner_user_id: null });
    const { bindings } = createDefaultHost({ ports: { bindings: { workspace } } });
    assert.deepEqual(bindings.workspace('w9'), { id: 'w9', cwd: '/ws/w9', owner_user_id: null });
    bindings.recordNativeSessionId(chat, 'native-1');
    bindings.crewMemory?.pin('n1', 'temporary');
    const node = bindings.nodeBinding('n1');
    assert.equal(node?.external_session_id, 'native-1');
    assert.equal(node?.crew_memory_mode, 'temporary');
  });

  it('refuses to remove a required port', () => {
    assert.throws(
      () => createDefaultHost({ ports: { permissions: undefined, title: undefined, workflows: undefined } }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeHostConfigError);
        assert.equal(error.who, 'createDefaultHost');
        assert.deepEqual(error.missing, ['permissions', 'title', 'workflows']);
        assert.equal(error.message, 'createDefaultHost requires host ports that are missing: permissions, title, workflows');
        return true;
      },
    );
    for (const name of [
      'config', 'prompt', 'profile', 'bindings', 'sessions', 'permissions', 'principal', 'observability', 'title',
      'backgroundTurns', 'workflows', 'backgroundSubagents',
    ] as const) {
      assert.throws(() => createDefaultHost({ ports: { [name]: undefined } }), RuntimeHostConfigError, name);
    }
  });

  it('replaces function members and removes optional ports given as undefined', () => {
    const onSessionStateChanged = () => {};
    const host = createDefaultHost({ ports: { onSessionStateChanged, interaction: undefined } });
    assert.equal(host.onSessionStateChanged, onSessionStateChanged);
    assert.equal(host.interaction, undefined);
    assert.equal('interaction' in host, false);
  });
});

describe('assertHostPorts', () => {
  it('accepts a complete default host', () => {
    assertHostPorts(createDefaultHost(), [
      'config', 'prompt', 'profile', 'bindings', 'sessions', 'permissions', 'principal', 'observability', 'title',
      'backgroundTurns', 'workflows', 'backgroundSubagents', 'bindings.crewMemory',
    ], 'test adapter');
  });

  it('lists every missing port and who needs them', () => {
    const { prompt: _prompt, workflows: _workflows, ...rest } = createDefaultHost();
    const partial: Partial<RuntimeHost> = { ...rest, bindings: { ...rest.bindings, crewMemory: undefined } };
    assert.throws(
      () => assertHostPorts(partial, ['config', 'prompt', 'workflows', 'interaction', 'bindings.crewMemory'], 'CrewRuntime'),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeHostConfigError);
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'RuntimeHostConfigError');
        assert.equal(error.who, 'CrewRuntime');
        assert.deepEqual(error.missing, ['prompt', 'workflows', 'interaction', 'bindings.crewMemory']);
        assert.equal(error.message, 'CrewRuntime requires host ports that are missing: prompt, workflows, interaction, bindings.crewMemory');
        return true;
      },
    );
  });

  it('treats an absent host as missing everything', () => {
    assert.throws(
      () => assertHostPorts(undefined, ['config', 'bindings.crewMemory'], 'ClaudeRuntime'),
      (error: unknown) => error instanceof RuntimeHostConfigError && error.missing.length === 2,
    );
  });
});
