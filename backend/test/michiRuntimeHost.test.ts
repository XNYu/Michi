import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { assertHostPorts, createDefaultHost } from 'michi-runtime';
import { createMichiRuntimeHost } from '../src/agents/michiRuntimeHost';
import * as agentConfig from '../src/services/agentConfig';
import * as agentOwner from '../src/services/agentOwner';
import * as backgroundSubagentRegistry from '../src/services/backgroundSubagentRegistry';
import * as branchBoundary from '../src/services/branchBoundary';
import * as dataDir from '../src/services/dataDir';
import * as dbRepository from '../src/services/dbRepository';
import * as logger from '../src/services/logger';
import * as perf from '../src/services/perf';
import * as sessionStatePersistence from '../src/services/sessionStatePersistence';
import * as startupTrace from '../src/services/startupTrace';
import * as streamProbe from '../src/services/streamProbe';
import * as titleGeneration from '../src/services/titleGeneration';
import * as workflowRunHub from '../src/services/workflowRunHub';
import * as assistantIdentity from '../src/assistant/identity';
import * as assistantPolicy from '../src/assistant/policy';
import { michiPermissionPolicy } from '../src/agents/chatApprovalState';
import { chatHub } from '../src/agents/chatHub';
import * as claudeForkAnchors from '../src/services/claudeForkAnchors';
import * as crewMemory from '../src/services/crewMemory';
import * as followUpsExperiment from '../src/agents/followUpsExperiment';
import * as kiroForkAnchors from '../src/services/kiroForkAnchors';
import * as kiroHostText from '../src/agents/hostText/kiro';
import { KIRO_METADATA_DONE_SENTINEL } from 'michi-runtime/internal/adapters/kiro/kiroProtocol';
import { CLAUDE_RESTRICTED_DISALLOWED_TOOLS, claudeSpawnPolicy } from 'michi-runtime/internal/adapters/claude/claudeRestrictedProfile';
import {
  CODEX_RESTRICTED_FEATURES_OFF, CODEX_RESTRICTED_TURN_POLICY, codexRestrictedMcpCheck, codexRestrictedThreadConfig, codexThreadSandbox,
} from 'michi-runtime/internal/adapters/codex/codexRestrictedProfile';
import * as nodeSummaryExperiment from '../src/agents/nodeSummaryExperiment';
import * as permissionPolicy from '../src/agents/permissionPolicy';
import * as preamble from '../src/agents/preamble';
import * as runtimeDeps from '../src/agents/runtimeDeps';
import * as sessionRegistry from '../src/agents/sessionRegistry';
import { TurnMetadataState } from '../src/agents/turnMetadataState';
import type { AgentSession, BranchContext, RuntimeSessionOwner } from '../src/agents/types';
import { chatOwner, hostOwner, runOwner } from './helpers/owners';

type AnyFn = (...args: any[]) => any;
const chat: RuntimeSessionOwner = chatOwner('n1');
const run: RuntimeSessionOwner = runOwner('r1', 'a1');

/**
 * Stubs `target[name]` with a function returning a unique value, invokes the
 * port, and checks the stub got exactly `args` (and `thisArg`, for instance
 * methods) and the port returned the stub's value.
 */
function expectDelegation(
  t: TestContext,
  target: object,
  name: string,
  invoke: () => unknown,
  args: unknown[],
  thisArg?: unknown,
): void {
  const result = Symbol(name);
  const stub = t.mock.method(target as Record<string, AnyFn>, name, () => result);
  const returned = invoke();
  assert.equal(stub.mock.callCount(), 1);
  assert.deepEqual(stub.mock.calls[0].arguments, args);
  if (thisArg !== undefined) assert.equal(stub.mock.calls[0].this, thisArg);
  assert.equal(returned, result);
}

/** Temporarily replaces an exported constant; the module object holds it as a plain property. */
function withExport<T>(target: object, name: string, value: unknown, run: () => T): T {
  const holder = target as Record<string, unknown>;
  const original = holder[name];
  holder[name] = value;
  try { return run(); } finally { holder[name] = original; }
}

describe('createMichiRuntimeHost', () => {
  it('provides every port an adapter can require, without an interaction broker', () => {
    const host = createMichiRuntimeHost();
    assertHostPorts(host, [
      'config', 'prompt', 'profile', 'bindings', 'sessions', 'permissions', 'principal', 'observability', 'title',
      'backgroundTurns', 'workflows', 'backgroundSubagents', 'onSessionStateChanged', 'bindings.crewMemory',
    ], 'test');
    assert.equal(host.interaction, undefined);
  });
});

describe('config', () => {
  const { config } = createMichiRuntimeHost();

  it('defaultModel → agentConfig.resolveModel', (t) => {
    expectDelegation(t, agentConfig, 'resolveModel', () => config.defaultModel('codex', 'u1'), ['codex', 'u1']);
    t.mock.restoreAll();
    expectDelegation(t, agentConfig, 'resolveModel', () => config.defaultModel('claude', null), ['claude', undefined]);
  });

  it('defaultReasoning → agentConfig.resolveReasoning', (t) => {
    expectDelegation(t, agentConfig, 'resolveReasoning', () => config.defaultReasoning('codex', 'u1'), ['codex', 'u1']);
    t.mock.restoreAll();
    expectDelegation(t, agentConfig, 'resolveReasoning', () => config.defaultReasoning('claude', null), ['claude', undefined]);
  });

  it('titleModel → titleGeneration.titleModelConfig', (t) => {
    expectDelegation(t, titleGeneration, 'titleModelConfig', () => config.titleModel('kiro'), ['kiro']);
    t.mock.restoreAll();
    expectDelegation(t, titleGeneration, 'titleModelConfig', () => config.titleModel('codex'), ['codex']);
  });

  it('titleModel disables sidecar titles for runtimes titleModelConfig does not know', () => {
    for (const runtimeId of ['claude', 'crew', 'pi']) {
      assert.deepEqual(config.titleModel(runtimeId), { model: null, timeoutMs: titleGeneration.DEFAULT_TITLE_TIMEOUT_MS });
    }
    assert.equal(titleGeneration.DEFAULT_TITLE_TIMEOUT_MS, 15_000);
  });

  it('onDefaultModelChanged → agentConfigEvents model_changed', () => {
    const events = agentConfig.agentConfigEvents;
    const seen: unknown[] = [];
    const before = events.listenerCount('model_changed');
    const off = config.onDefaultModelChanged((event) => seen.push(event));
    assert.equal(events.listenerCount('model_changed'), before + 1);
    events.emit('model_changed', { runtime: 'claude', model: 'opus' });
    off();
    assert.equal(events.listenerCount('model_changed'), before);
    events.emit('model_changed', { runtime: 'claude', model: 'sonnet' });
    assert.deepEqual(seen, [{ runtime: 'claude', model: 'opus' }]);
  });

  it('features.workflows → agentConfig.isWorkflowsEnabled', (t) => {
    expectDelegation(t, agentConfig, 'isWorkflowsEnabled', () => config.features.workflows('kiro', 'u1'), ['kiro', 'u1']);
  });

  it('dataDir → dataDir.getMichiDataDir', (t) => {
    expectDelegation(t, dataDir, 'getMichiDataDir', () => config.dataDir(), []);
  });
});

describe('prompt', () => {
  const { prompt } = createMichiRuntimeHost();
  const branch: BranchContext = { parentNodeId: 'p', kind: 'exact', messages: [{ role: 'user', content: 'hi' }] };

  it('firstTurnPrefix → preamble.buildFirstTurnPrefix', (t) => {
    const input = { cwd: '/w', workspaceInstructions: 'be brief' };
    expectDelegation(t, preamble, 'buildFirstTurnPrefix', () => prompt.firstTurnPrefix(input), [input]);
  });

  it('preamble → preamble.buildPreamble', (t) => {
    const input = { cwd: '/w', enableFollowUps: true };
    expectDelegation(t, preamble, 'buildPreamble', () => prompt.preamble(input), [input]);
  });

  it('stableSystemPrompt → preamble.buildStableSystemPrompt, with the assistant tool note when restricted', (t) => {
    expectDelegation(t, preamble, 'buildStableSystemPrompt', () => prompt.stableSystemPrompt('structured-tool', true, true),
      ['structured-tool', true, true, undefined]);
    t.mock.restoreAll();
    expectDelegation(t, preamble, 'buildStableSystemPrompt',
      () => prompt.stableSystemPrompt('sentinel', false, false, false),
      ['sentinel', false, false, undefined]);
    t.mock.restoreAll();
    expectDelegation(t, preamble, 'buildStableSystemPrompt',
      () => prompt.stableSystemPrompt('sentinel', true, false, true),
      ['sentinel', true, false, 'assistant']);
  });

  it('stableSystemPrompt matches the direct calls byte for byte', () => {
    // ClaudeSessionManager.ts:232-233 and CodexRuntime.ts:662.
    assert.equal(prompt.stableSystemPrompt('sentinel', true, false, true), preamble.buildStableSystemPrompt('sentinel', true, false, 'assistant'));
    assert.equal(prompt.stableSystemPrompt('sentinel', true, true), preamble.buildStableSystemPrompt('sentinel', true, true));
    assert.equal(prompt.stableSystemPrompt('structured-tool', false, false, false), preamble.buildStableSystemPrompt('structured-tool', false, false, 'michi'));
    assert.equal(prompt.stableSystemPrompt(), preamble.buildStableSystemPrompt());
  });

  it('turnSuffix reproduces the reminders KiroSession.send appends today', () => {
    // The expression KiroSession.send appended before it asked turnSuffix: (reminder || "") + overviewReminder.
    const today = (crew: boolean, userTurnCount: number, enableFollowUps: boolean, owner: RuntimeSessionOwner | undefined) => {
      const reminder = crew ? '' : preamble.followUpReminder(userTurnCount, enableFollowUps);
      const overviewReminder = crew
        ? (owner && hostOwner(owner).kind === 'agent_run' ? '' : kiroHostText.crewTurnFormat(enableFollowUps))
        : (nodeSummaryExperiment.fullNodeSummaryExperimentEnabled()
          ? kiroHostText.FULL_BRANCH_OVERVIEW_TOOL_REMINDER
          : kiroHostText.BRANCH_OVERVIEW_TOOL_REMINDER);
      return (reminder || '') + overviewReminder;
    };
    const original = process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE;
    let cases = 0;
    try {
      for (const summaryMode of [undefined, 'full']) {
        if (summaryMode === undefined) delete process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE;
        else process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE = summaryMode;
        for (const crew of [false, true]) {
          for (const userTurnCount of [1, 2, 6, 7, 8, 12, 17]) {
            for (const enableFollowUps of [true, false]) {
              for (const owner of [chat, run, undefined]) {
                const metadataChannel = crew ? 'inline' : 'tools';
                assert.equal(prompt.turnSuffix({ metadataChannel, userTurnCount, enableFollowUps, owner }),
                  today(crew, userTurnCount, enableFollowUps, owner), JSON.stringify({ summaryMode, crew, userTurnCount, enableFollowUps, owner }));
                cases += 1;
              }
            }
          }
        }
      }
    } finally {
      if (original === undefined) delete process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE;
      else process.env.MICHI_NODE_SUMMARY_EXPERIMENT_MODE = original;
    }
    assert.equal(cases, 168);
  });

  it('turnSuffix carries the Kiro and Crew protocol text', () => {
    const tools = prompt.turnSuffix({ metadataChannel: 'tools', userTurnCount: 1, enableFollowUps: true, owner: chat });
    assert.ok(tools.includes('set_branch_overview') && tools.includes(KIRO_METADATA_DONE_SENTINEL));
    assert.equal(prompt.turnSuffix({ metadataChannel: 'inline', userTurnCount: 1, enableFollowUps: false, owner: chat }), kiroHostText.crewTurnFormat(false));
    assert.equal(prompt.turnSuffix({ metadataChannel: 'inline', userTurnCount: 1, enableFollowUps: true, owner: run }), '');
  });

  it('followUpsExperimentMode → followUpsExperiment.resolveFollowUpsExperimentMode', (t) => {
    expectDelegation(t, followUpsExperiment, 'resolveFollowUpsExperimentMode', () => prompt.followUpsExperimentMode(), []);
  });

  it('followUpsMetadataOutputMode → followUpsExperiment.followUpsMetadataOutputMode', (t) => {
    expectDelegation(t, followUpsExperiment, 'followUpsMetadataOutputMode',
      () => prompt.followUpsMetadataOutputMode(true, 'hook-tool'), [true, 'hook-tool']);
  });

  it('followUpsTurnReminder → followUpsExperiment.followUpsTurnReminder', (t) => {
    expectDelegation(t, followUpsExperiment, 'followUpsTurnReminder',
      () => prompt.followUpsTurnReminder(3, false, 'sentinel', false), [3, false, 'sentinel', false]);
    t.mock.restoreAll();
    expectDelegation(t, followUpsExperiment, 'followUpsTurnReminder',
      () => prompt.followUpsTurnReminder(3, true, 'sentinel'), [3, true, 'sentinel']);
  });

  it('renderBranchContext → branchBoundary.renderBranchContext', (t) => {
    expectDelegation(t, branchBoundary, 'renderBranchContext', () => prompt.renderBranchContext(branch), [branch]);
    t.mock.restoreAll();
    expectDelegation(t, branchBoundary, 'renderBranchContext', () => prompt.renderBranchContext(branch, 'Parent'), [branch, 'Parent']);
  });

  it('workspaceInstructions → dbRepository.getWorkspaceInstructions', (t) => {
    expectDelegation(t, dbRepository, 'getWorkspaceInstructions', () => prompt.workspaceInstructions('w1'), ['w1']);
  });

  it('turnMetadata → new TurnMetadataState(mode)', () => {
    const tool = prompt.turnMetadata('hook-tool');
    assert.ok(tool instanceof TurnMetadataState);
    assert.equal(tool.acceptsFollowUps(true), true);
    const sentinel = prompt.turnMetadata('sentinel');
    assert.ok(sentinel instanceof TurnMetadataState);
    assert.equal(sentinel.acceptsFollowUps(true), false);
    assert.notEqual(prompt.turnMetadata('sentinel'), sentinel);
  });
});

describe('profile', () => {
  const { profile } = createMichiRuntimeHost();
  const toolProfile = { allowedToolNames: ['list_threads'], restricted: true };

  it('honors generic restricted profiles and both legacy Meta agent toolsets', () => {
    assert.equal(profile.isRestricted(toolProfile), true);
    assert.equal(profile.isRestricted({ assistant: true }), true);
    assert.equal(profile.isRestricted({ maintenance: true }), true);
    assert.equal(profile.isRestricted(undefined), false);
    assert.equal(profile.isRestricted({ allowedToolNames: [] }), false);
  });

  it('isRestrictedWorkspace → assistantIdentity.isAssistantWorkspace', (t) => {
    expectDelegation(t, assistantIdentity, 'isAssistantWorkspace', () => profile.isRestrictedWorkspace('w1'), ['w1']);
  });

  it('composeFirstTurnPrefix → assistantPolicy.chatFirstTurnPrefix', (t) => {
    expectDelegation(t, assistantPolicy, 'chatFirstTurnPrefix',
      () => profile.composeFirstTurnPrefix('context', 'bootstrap', toolProfile), ['context', 'bootstrap', toolProfile]);
  });

  it('unsupportedError → new AssistantRuntimeUnsupportedError(runtimeId)', () => {
    const error = profile.unsupportedError('kiro');
    assert.ok(error instanceof assistantPolicy.AssistantRuntimeUnsupportedError);
    assert.equal(error.message, new assistantPolicy.AssistantRuntimeUnsupportedError('kiro').message);
  });

  it('the adapters and the default host lock a restricted session down exactly as Michi locks its assistant', () => {
    const fallback = createDefaultHost().profile;
    const restricted = assistantPolicy.assistantToolProfile();
    for (const ownerMode of ['interactive', 'headless'] as const) {
      for (const permissionMode of ['yolo', 'ask', undefined] as const) {
        for (const toolProfile of [restricted, { restricted: true }, { maintenance: true as const }, undefined, { allowedToolNames: ['read'] }]) {
          const input = { ownerMode, permissionMode, toolProfile };
          // The Claude adapter gets the host's verdict: Michi's isRestricted is isAssistantProfile.
          assert.deepEqual(claudeSpawnPolicy(profile.isRestricted(toolProfile), input), assistantPolicy.claudeSpawnPolicy(input));
        }
      }
    }
    assert.deepEqual([...CLAUDE_RESTRICTED_DISALLOWED_TOOLS], [...assistantPolicy.CLAUDE_ASSISTANT_DISALLOWED_TOOLS]);
    assert.equal(fallback.isRestricted(restricted), assistantPolicy.isAssistantProfile(restricted));
    // The Codex adapter: sandbox, turn policy and approvals; its thread config and MCP check are Michi's own (re-exported).
    for (const toolProfile of [restricted, { restricted: true }, { maintenance: true as const }, undefined, { allowedToolNames: ['read'] }]) {
      assert.equal(codexThreadSandbox(profile.isRestricted(toolProfile)), assistantPolicy.codexThreadSandbox(toolProfile));
    }
    assert.deepEqual(CODEX_RESTRICTED_TURN_POLICY, assistantPolicy.CODEX_ASSISTANT_TURN_POLICY);
    assert.equal(assistantPolicy.codexAssistantApproval(), 'decline', 'the adapter declines every approval of a restricted session');
    assert.equal(assistantPolicy.codexAssistantThreadConfig, codexRestrictedThreadConfig);
    assert.equal(assistantPolicy.codexAssistantMcpCheck, codexRestrictedMcpCheck);
    assert.equal(assistantPolicy.CODEX_ASSISTANT_FEATURES_OFF, CODEX_RESTRICTED_FEATURES_OFF);
    assert.equal(assistantPolicy.CODEX_MICHI_MCP_SERVER, '__michi_internal__');
  });
});

describe('bindings', () => {
  const { bindings } = createMichiRuntimeHost();

  it('nodeBinding → dbRepository.getNode', (t) => {
    expectDelegation(t, dbRepository, 'getNode', () => bindings.nodeBinding('n1'), ['n1']);
  });

  it('workspace → dbRepository.getWorkspace', (t) => {
    expectDelegation(t, dbRepository, 'getWorkspace', () => bindings.workspace('w1'), ['w1']);
  });

  it('edges → dbRepository.listEdges', (t) => {
    expectDelegation(t, dbRepository, 'listEdges', () => bindings.edges('w1'), ['w1']);
  });

  it('recordNativeSessionId → dbRepository.setNodeExternalSessionId', (t) => {
    expectDelegation(t, dbRepository, 'setNodeExternalSessionId', () => bindings.recordNativeSessionId(chat, 'native-1'), ['n1', 'native-1']);
  });

  it('recordNativeSessionId fails closed for an Agent Run owner, without touching the store', (t) => {
    const store = t.mock.method(dbRepository, 'setNodeExternalSessionId', () => {});
    assert.throws(() => bindings.recordNativeSessionId(run, 'native-1'), /Only a chat session records a native session id/);
    assert.equal(store.mock.callCount(), 0);
  });

  it('recordNativeSessionId rethrows the store failure unchanged', (t) => {
    const failure = new Error('Cannot bind native session: node n1 does not exist');
    t.mock.method(dbRepository, 'setNodeExternalSessionId', () => { throw failure; });
    assert.throws(() => bindings.recordNativeSessionId(chat, 'native-1'), (error: unknown) => error === failure);
  });

  it('forkAnchors.saveKiroForkAnchor → kiroForkAnchors.saveKiroForkAnchor', (t) => {
    const input = { nodeId: 'n1', nativeSessionId: 's1', engine: 'v3', assistantMessageId: 'a1', anchor: { logIndex: 2 } };
    expectDelegation(t, kiroForkAnchors, 'saveKiroForkAnchor', () => bindings.forkAnchors.saveKiroForkAnchor(input), [input]);
  });

  it('forkAnchors.readKiroForkAnchor → kiroForkAnchors.readKiroForkAnchor', (t) => {
    expectDelegation(t, kiroForkAnchors, 'readKiroForkAnchor',
      () => bindings.forkAnchors.readKiroForkAnchor('n1', 's1', 'v2', 'm1'), ['n1', 's1', 'v2', 'm1']);
  });

  it('forkAnchors.saveClaudeForkAnchor → claudeForkAnchors.saveClaudeForkAnchor', (t) => {
    const input = { nodeId: 'n1', nativeSessionId: 's1', assistantMessageId: 'a1', nativeMessageId: 'na1' };
    expectDelegation(t, claudeForkAnchors, 'saveClaudeForkAnchor', () => bindings.forkAnchors.saveClaudeForkAnchor(input), [input]);
  });

  it('forkAnchors.readClaudeForkAnchor → claudeForkAnchors.readClaudeForkAnchor', (t) => {
    const input = { nodeId: 'n1', nativeSessionId: 's1', messageId: 'm1', workspaceId: 'w1', ownerUserId: null };
    expectDelegation(t, claudeForkAnchors, 'readClaudeForkAnchor', () => bindings.forkAnchors.readClaudeForkAnchor(input), [input]);
  });

  it('crewMemory.defaultMode → crewMemory.defaultCrewMemory', (t) => {
    expectDelegation(t, crewMemory, 'defaultCrewMemory', () => bindings.crewMemory!.defaultMode('u1'), ['u1']);
  });

  it('crewMemory.pin → crewMemory.pinCrewMemory', (t) => {
    expectDelegation(t, crewMemory, 'pinCrewMemory', () => bindings.crewMemory!.pin('n1', 'incognito'), ['n1', 'incognito']);
  });
});

describe('sessions', () => {
  const { sessions } = createMichiRuntimeHost();
  const session: AgentSession = {
    id: 'n1', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
    async *send() {}, cancel: () => {},
  };

  it('ensureAncestorChainLoaded → sessionRegistry.ensureAncestorChainLoaded', (t) => {
    expectDelegation(t, sessionRegistry, 'ensureAncestorChainLoaded', () => sessions.ensureAncestorChainLoaded('n1'), ['n1']);
  });

  it('getSession → sessionRegistry.getSession', (t) => {
    expectDelegation(t, sessionRegistry, 'getSession', () => sessions.getSession('n1'), ['n1']);
  });

  it('getAncestors → sessionRegistry.getAncestors', (t) => {
    expectDelegation(t, sessionRegistry, 'getAncestors', () => sessions.getAncestors('n1'), ['n1']);
  });

  it('registerSession → sessionRegistry.registerSession, with the arguments as passed', (t) => {
    expectDelegation(t, sessionRegistry, 'registerSession', () => sessions.registerSession(session, 'u1'), [session, 'u1']);
  });

  it('registerSession passes an explicit owner through', (t) => {
    expectDelegation(t, sessionRegistry, 'registerSession', () => sessions.registerSession(session, null, run), [session, null, run]);
  });

  it('dropSession → sessionRegistry.dropSession', (t) => {
    expectDelegation(t, sessionRegistry, 'dropSession', () => sessions.dropSession('n1'), ['n1']);
  });

  it('is the process-wide registry: the app reads what an adapter registers through the port', () => {
    try {
      sessions.registerSession(session, 'u1', chat);
      assert.equal(sessionRegistry.getSession('n1'), session);
      assert.equal(sessionRegistry.getSessionForOwner('n1', chat, 'u1'), session);
      assert.equal(createMichiRuntimeHost().sessions.getSession('n1'), session);
      sessions.dropSession('n1');
      assert.equal(sessionRegistry.getSession('n1'), undefined);
    } finally {
      sessionRegistry.clearAllSessions();
    }
  });
});

describe('permissions', () => {
  const { permissions } = createMichiRuntimeHost();

  it('is the port the sessions\' ChatApprovalState uses', () => {
    assert.equal(permissions, michiPermissionPolicy);
  });

  it('mode → permissionPolicy.chatPermissionMode', (t) => {
    expectDelegation(t, permissionPolicy, 'chatPermissionMode', () => permissions.mode(chat, 'u1'), [chat, 'u1']);
    t.mock.restoreAll();
    expectDelegation(t, permissionPolicy, 'chatPermissionMode', () => permissions.mode(chat), [chat]);
  });

  it('resolveOwnerUserId → permissionPolicy.permissionOwnerUserId', (t) => {
    expectDelegation(t, permissionPolicy, 'permissionOwnerUserId', () => permissions.resolveOwnerUserId(chat, null), [chat, null]);
  });

  it('decide → permissionPolicy.resolveChatPolicy', (t) => {
    expectDelegation(t, permissionPolicy, 'resolveChatPolicy',
      () => permissions.decide({ owner: chat, ownerUserId: 'u1', toolName: 'bash', nativeRequest: true, mode: 'trust' }),
      [chat, 'u1', 'bash', true, 'trust']);
    t.mock.restoreAll();
    expectDelegation(t, permissionPolicy, 'resolveChatPolicy',
      () => permissions.decide({ owner: chat, ownerUserId: null, toolName: 'Read' }),
      [chat, null, 'Read', undefined, undefined]);
  });

  it('grant → permissionPolicy.grantChatPermission', (t) => {
    expectDelegation(t, permissionPolicy, 'grantChatPermission',
      () => permissions.grant({ owner: chat, ownerUserId: 'u1', toolName: 'bash' }), [chat, 'bash', 'u1']);
  });

  it('resetToken → runtimeDeps chatPermissions.resetToken for the chat owner', (t) => {
    const resetToken = t.mock.fn((_nodeId: string, _userId?: string | null) => 'token-1');
    t.mock.method(runtimeDeps, 'getRuntimeDeps', () => ({ chatPermissions: { resetToken } }));
    t.mock.method(permissionPolicy, 'permissionOwnerUserId', () => 'owner-u');
    assert.equal(permissions.resetToken!(chat, undefined), 'token-1');
    assert.deepEqual(resetToken.mock.calls[0].arguments, ['n1', 'owner-u']);
  });

  it('resetToken is undefined for Agent Runs and without configured runtime deps', (t) => {
    const getDeps = t.mock.method(runtimeDeps, 'getRuntimeDeps', () => { throw new Error('runtime deps not configured'); });
    assert.equal(permissions.resetToken!(run, 'u1'), undefined);
    assert.equal(getDeps.mock.callCount(), 0);
    assert.equal(permissions.resetToken!(chat, 'u1'), undefined);
    assert.equal(getDeps.mock.callCount(), 1);
  });
});

describe('principal', () => {
  const { principal } = createMichiRuntimeHost();

  it('resolve → ownerUserId ?? LOCAL_AGENT_OWNER_ID', () => {
    assert.equal(principal.resolve('u1'), 'u1');
    assert.equal(principal.resolve(null), agentOwner.LOCAL_AGENT_OWNER_ID);
    assert.equal(principal.resolve(undefined), agentOwner.LOCAL_AGENT_OWNER_ID);
    withExport(agentOwner, 'LOCAL_AGENT_OWNER_ID', 'swapped', () => {
      assert.equal(principal.resolve(undefined), 'swapped');
    });
  });

  it('workspaceOwnerMatches → agentOwner.workspaceOwnerMatches', (t) => {
    expectDelegation(t, agentOwner, 'workspaceOwnerMatches', () => principal.workspaceOwnerMatches(null, 'local-user'), [null, 'local-user']);
  });

  it('enforceUserOwnership → process.env.MICHI_CLOUD === "1", read on every call', () => {
    const original = process.env.MICHI_CLOUD;
    try {
      process.env.MICHI_CLOUD = '1';
      assert.equal(principal.enforceUserOwnership(), true);
      process.env.MICHI_CLOUD = '0';
      assert.equal(principal.enforceUserOwnership(), false);
      delete process.env.MICHI_CLOUD;
      assert.equal(principal.enforceUserOwnership(), false);
    } finally {
      if (original === undefined) delete process.env.MICHI_CLOUD;
      else process.env.MICHI_CLOUD = original;
    }
  });
});

describe('observability', () => {
  const { observability } = createMichiRuntimeHost();

  it('log → logger.log[level]', (t) => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      expectDelegation(t, logger.log, level, () => observability.log(level, 'chat', 'message', { nodeId: 'n1' }),
        ['chat', 'message', { nodeId: 'n1' }], logger.log);
      t.mock.restoreAll();
    }
  });

  it('perf.now → perf.now', (t) => {
    expectDelegation(t, perf, 'now', () => observability.perf.now(), []);
  });

  it('perf.mark → perf.mark', (t) => {
    expectDelegation(t, perf, 'mark', () => observability.perf.mark('acp:spawn', { pid: 1 }), ['acp:spawn', { pid: 1 }]);
  });

  it('perf.measure → perf.measure', (t) => {
    expectDelegation(t, perf, 'measure', () => observability.perf.measure('acp:spawn', 12.5, { pid: 1 }), ['acp:spawn', 12.5, { pid: 1 }]);
  });

  it('startupMark → startupTrace.startupMark', (t) => {
    expectDelegation(t, startupTrace, 'startupMark', () => observability.startupMark!('kiro_spawn_start', { cwd: '/w' }), ['kiro_spawn_start', { cwd: '/w' }]);
  });

  it('streamProbe.enabled → streamProbe.BACKEND_STREAM_PROBE_ENABLED', () => {
    for (const value of [true, false]) {
      withExport(streamProbe, 'BACKEND_STREAM_PROBE_ENABLED', value, () => {
        assert.equal(observability.streamProbe!.enabled(), value);
      });
    }
  });

  it('streamProbe.write → streamProbe.writeBackendStreamProbe', (t) => {
    const row = { phase: 'raw_update', seq: 1 };
    expectDelegation(t, streamProbe, 'writeBackendStreamProbe', () => observability.streamProbe!.write(row), [row]);
  });

  it('childStderr → logger.log.acpStderr', (t) => {
    expectDelegation(t, logger.log, 'acpStderr', () => observability.childStderr!('crew', 'boom\n'), ['boom\n'], logger.log);
  });
});

describe('title', () => {
  const { title } = createMichiRuntimeHost();

  it('enabled is true for every runtime, as Michi titles every chat today', () => {
    for (const runtimeId of ['kiro', 'crew', 'codex', 'claude', 'pi']) assert.equal(title.enabled(runtimeId), true);
  });

  it('prompt → titleGeneration.buildTitlePrompt', (t) => {
    expectDelegation(t, titleGeneration, 'buildTitlePrompt', () => title.prompt('hello', 'quoted'), ['hello', 'quoted']);
  });

});

describe('backgroundTurns', () => {
  const { backgroundTurns } = createMichiRuntimeHost();

  it('consume → chatHub.startSelfTurn, on the chat node the owner stands for', (t) => {
    const events = (async function* () {})();
    const turn = { chatId: 'n1', owner: chat, ownerUserId: null, events };
    expectDelegation(t, chatHub, 'startSelfTurn', () => backgroundTurns!.consume(turn),
      [{ chatId: 'n1', nodeId: 'n1', ownerUserId: null, events }], chatHub);
  });

  it('consume cancels and drains a turn whose owner is not a chat', async (t) => {
    const start = t.mock.method(chatHub, 'startSelfTurn', () => {});
    let warned!: () => void;
    const logged = new Promise<void>((resolve) => { warned = resolve; });
    const warn = t.mock.method(logger.log, 'warn', () => { warned(); });
    let cancelled = false;
    let drained!: () => void;
    const done = new Promise<void>((resolve) => { drained = resolve; });
    const events = (async function* () { yield { kind: 'chunk', text: 'a' } as const; drained(); })();
    backgroundTurns!.consume({ chatId: 'a1', owner: run, events, cancel: () => { cancelled = true; } });
    await done;
    await logged;
    assert.equal(cancelled, true);
    assert.equal(start.mock.callCount(), 0);
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments),
      [['chat', 'background turn discarded: its owner is not a chat', { chatId: 'a1', mode: 'headless' }]]);
  });

  it('isActive → chatHub.isActive', (t) => {
    expectDelegation(t, chatHub, 'isActive', () => backgroundTurns!.isActive('n1'), ['n1'], chatHub);
  });

  it('isOwnerTurnActive → chatHub.isOwnerTurnActive', (t) => {
    expectDelegation(t, chatHub, 'isOwnerTurnActive', () => backgroundTurns!.isOwnerTurnActive('n1'), ['n1'], chatHub);
  });

  it('hasPendingSelfTurn → chatHub.hasPendingSelfTurn', (t) => {
    expectDelegation(t, chatHub, 'hasPendingSelfTurn', () => backgroundTurns!.hasPendingSelfTurn('n1'), ['n1'], chatHub);
  });
});

describe('workflows', () => {
  const { workflows } = createMichiRuntimeHost();
  const hub = workflowRunHub.workflowRunHub;
  const context = { ownerUserId: 'u1', workspaceId: 'w1', owner: chat };
  const mutate = (run: any) => run;

  it('update → workflowRunHub.update, on the chat node the owner stands for (none for an Agent Run)', (t) => {
    expectDelegation(t, hub, 'update', () => workflows!.update(context, 'kiro', 'wf1', mutate),
      [{ ownerUserId: 'u1', workspaceId: 'w1', nodeId: 'n1' }, 'kiro', 'wf1', mutate], hub);
    t.mock.restoreAll();
    expectDelegation(t, hub, 'update', () => workflows!.update({ ...context, owner: run }, 'claude', 'task1', mutate),
      [{ ownerUserId: 'u1', workspaceId: 'w1', nodeId: null }, 'claude', 'task1', mutate], hub);
  });

  it('updateKnown → workflowRunHub.updateKnown', (t) => {
    expectDelegation(t, hub, 'updateKnown', () => workflows!.updateKnown('claude', 'task1', mutate), ['claude', 'task1', mutate], hub);
  });

  it('registerControls → workflowRunHub.registerControls', (t) => {
    const controls = { stop: async () => {} };
    expectDelegation(t, hub, 'registerControls', () => workflows!.registerControls('u1', 'kiro', 'wf1', controls), ['u1', 'kiro', 'wf1', controls], hub);
  });

  it('requestApproval → workflowRunHub.requestApproval', (t) => {
    const approval = { id: 'ap1' } as never;
    const resolve = () => {};
    expectDelegation(t, hub, 'requestApproval', () => workflows!.requestApproval('u1', 'kiro', 'wf1', approval, resolve),
      ['u1', 'kiro', 'wf1', approval, resolve], hub);
  });

  it('withdrawApproval → workflowRunHub.withdrawApproval', (t) => {
    expectDelegation(t, hub, 'withdrawApproval', () => workflows!.withdrawApproval('u1', 'claude', 'task1', 'ap1'), ['u1', 'claude', 'task1', 'ap1'], hub);
  });

  it('releaseControls → workflowRunHub.releaseControls', (t) => {
    expectDelegation(t, hub, 'releaseControls', () => workflows!.releaseControls('u1', 'kiro', 'wf1', 'gone'), ['u1', 'kiro', 'wf1', 'gone'], hub);
  });
});

describe('backgroundSubagents', () => {
  const { backgroundSubagents } = createMichiRuntimeHost();
  const registry = backgroundSubagentRegistry.backgroundSubagentRegistry;
  const context = { ownerUserId: 'u1', workspaceId: 'w1', owner: chat };
  const michiContext = { ownerUserId: 'u1', workspaceId: 'w1', nodeId: 'n1' };

  it('report → backgroundSubagentRegistry.report, for the chat node the owner stands for', (t) => {
    const ids = ['s1'];
    expectDelegation(t, registry, 'report', () => backgroundSubagents!.report(context, 'claude:1', ids), [michiContext, 'claude:1', ids], registry);
  });

  it('end → backgroundSubagentRegistry.end, for the chat node the owner stands for', (t) => {
    const ends = [{ sessionId: 's1', outcome: 'stopped' }] as never[];
    expectDelegation(t, registry, 'end', () => backgroundSubagents!.end(context, 'codex:1', ends), [michiContext, 'codex:1', ends], registry);
  });

  it('an Agent Run owner reports no background subagents', (t) => {
    const report = t.mock.method(registry, 'report', () => {});
    const end = t.mock.method(registry, 'end', () => {});
    backgroundSubagents!.report({ ...context, owner: run }, 'claude:1', ['s1']);
    backgroundSubagents!.end({ ...context, owner: run }, 'claude:1', []);
    assert.equal(report.mock.callCount() + end.mock.callCount(), 0);
  });
});

describe('onSessionStateChanged', () => {
  it('→ sessionStatePersistence.persistSessionState', (t) => {
    const host = createMichiRuntimeHost();
    const session = { id: 'n1' } as AgentSession;
    const state = { modes: [] } as never;
    expectDelegation(t, sessionStatePersistence, 'persistSessionState', () => host.onSessionStateChanged!(session, 'u1', state), [session, 'u1', state]);
  });
});
