/**
 * Claude work modes (Default / Plan), separate from the approval policy.
 *
 * Probe-backed (.probe/claude/08-plan-switch.mjs, CLI 2.1.312): the SDK mode
 * can be switched to 'plan' before and during a turn; ExitPlanMode reaches
 * canUseTool in every mode, bypassPermissions included; an approved plan
 * makes the CLI leave plan mode by itself (for the mode it had before, or
 * 'default' when it was spawned in plan), reported by system/status; a
 * rejected plan keeps it in plan mode.
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { runOwner } from './helpers/owners';
import { claudeTestOptions } from './helpers/claudeTestOptions';
import {
  newScriptedSession, restoreClaudeSpawn, runningScriptedTurn, stubClaudeSpawn, until,
} from './helpers/claudeScriptedChild';
import { ClaudeRuntime } from 'michi-runtime/internal/adapters/claude/ClaudeRuntime';

type ChatMode = 'ask' | 'trust' | 'yolo';
const policy = require('../src/agents/permissionPolicy');
const originalMode = policy.chatPermissionMode;
let approvalMode: ChatMode = 'ask';

function permissionRequests(events: NormalizedEvent[]) {
  return events.filter((ev): ev is Extract<NormalizedEvent, { kind: 'permission_request' }> => ev.kind === 'permission_request');
}

/** A session whose SDK permission-mode controls are recorded. */
async function recordedSession(overrides: Record<string, unknown> = {}, beforeSpawn?: (session: any) => Promise<void>) {
  const scripted = await newScriptedSession(overrides, beforeSpawn);
  const modes: string[] = [];
  scripted.query.setPermissionMode = async (mode: string) => { modes.push(mode); };
  const notified: Array<string | null | undefined> = [];
  scripted.session.onSessionState(() => notified.push(scripted.session.getSessionState().currentModeId));
  return { ...scripted, modes, notified };
}

/** Ask Claude's canUseTool callback, as the CLI does, for a tool call of the running turn. */
function askTool(child: any, toolName: string, input: Record<string, unknown> = {}) {
  return child.spawnArgs.authorize(toolName, input, `tool-${toolName}`, new AbortController().signal) as Promise<{ behavior: string; message?: string }>;
}

describe('ClaudeSession work modes', () => {
  beforeEach(() => {
    stubClaudeSpawn();
    mock.restoreAll();
    approvalMode = 'ask';
    policy.chatPermissionMode = () => approvalMode;
  });
  afterEach(() => {
    restoreClaudeSpawn();
    mock.restoreAll();
    policy.chatPermissionMode = originalMode;
  });

  test('the runtime offers Default and Plan where Kiro lists its agents', async () => {
    const runtime = new ClaudeRuntime({ ...claudeTestOptions(), bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null } as any,
      mcpSlots: { create: () => ({ slotId: 's', workspaceId: null }), dispose: async () => {}, endpoint: () => ({ type: 'http', url: 'http://x', headers: [] }) } as any });
    try {
      assert.equal(runtime.capabilities.modes, true);
      assert.deepEqual((await runtime.listModes('')).map((mode) => [mode.id, mode.label]), [['default', 'Default'], ['plan', 'Plan']]);
    } finally { await runtime.shutdown(); }
  });

  test('a chat reports its mode and catalog; switching to Plan sets the SDK mode and notifies state listeners', async () => {
    approvalMode = 'yolo';
    const { session, modes, notified } = await recordedSession();
    try {
      const state = session.getSessionState();
      assert.equal(session.currentModeId, 'default');
      assert.equal(state.currentModeId, 'default');
      assert.deepEqual(state.availableModes?.map((mode) => mode.id), ['default', 'plan']);
      const version = state.version!;
      await session.setMode('plan');
      assert.deepEqual(modes, ['plan']);
      assert.equal(session.currentModeId, 'plan');
      assert.deepEqual(notified, ['plan']);
      assert.ok(session.getSessionState().version! > version);
      await session.setMode('plan');
      assert.deepEqual(modes, ['plan'], 'no change, no control');
      await assert.rejects(session.setMode('acceptEdits'), /Unknown Claude mode/);
    } finally { await session.dispose(); }
  });

  test('a YOLO turn in Plan keeps the SDK in plan mode instead of switching it to bypassPermissions', async () => {
    approvalMode = 'yolo';
    const { session, child, modes } = await recordedSession();
    try {
      await session.setMode('plan');
      const turn = await runningScriptedTurn(session, child, undefined, 'plan');
      child.result();
      await turn.done;
      assert.deepEqual(modes, ['plan']);
      assert.equal(session.currentModeId, 'plan');
    } finally { await session.dispose(); }
  });

  test('a session spawned while planning starts in the SDK plan mode', async () => {
    approvalMode = 'yolo';
    const { child, session } = await recordedSession({}, async (s) => { await s.setMode('plan'); });
    try {
      assert.equal((child as any).spawnArgs.permissionMode, 'plan');
    } finally { await session.dispose(); }
  });

  for (const mode of ['ask', 'trust', 'yolo'] as const) {
    test(`${mode}: the user reviews the plan; ExitPlanMode is never approved for them`, async () => {
      approvalMode = mode;
      const { session, child } = await recordedSession();
      try {
        await session.setMode('plan');
        const turn = await runningScriptedTurn(session, child, undefined, 'plan');
        const pending = askTool(child, 'ExitPlanMode', { plan: 'Create hello.txt containing HI.' });
        await until(() => permissionRequests(turn.events).length === 1, 'the plan review');
        const [review] = permissionRequests(turn.events);
        assert.equal(review.title, 'Approve the plan?');
        assert.match(review.detail ?? '', /Create hello\.txt containing HI\./);
        assert.deepEqual(review.options.map((option) => [option.optionId, option.name]), [['reject_once', 'Keep planning'], ['allow_once', 'Approve plan']]);
        session.respondToPermission(review.requestId, 'reject_once');
        const rejected = await pending;
        assert.equal(rejected.behavior, 'deny');
        assert.match(rejected.message ?? '', /did not approve the plan/);
        const again = askTool(child, 'ExitPlanMode', { plan: 'Create hello.txt containing HI.' });
        await until(() => permissionRequests(turn.events).length === 2, 'the second review');
        session.respondToPermission(permissionRequests(turn.events)[1].requestId, 'allow_once');
        assert.equal((await again).behavior, 'allow');
        child.result();
        await turn.done;
      } finally { await session.dispose(); }
    });
  }

  test('YOLO still approves other tools itself: only the plan review asks', async () => {
    approvalMode = 'yolo';
    const { session, child } = await recordedSession();
    try {
      const turn = await runningScriptedTurn(session, child);
      assert.equal((await askTool(child, 'Bash', { command: 'ls' })).behavior, 'allow');
      assert.equal(permissionRequests(turn.events).length, 0);
      child.result();
      await turn.done;
    } finally { await session.dispose(); }
  });

  test('trusting all tools for the session on another request does not answer a pending plan review', async () => {
    const { session, child } = await recordedSession();
    try {
      await session.setMode('plan');
      const turn = await runningScriptedTurn(session, child, undefined, 'plan');
      const plan = askTool(child, 'ExitPlanMode', { plan: 'Plan' });
      const bash = askTool(child, 'Bash', { command: 'ls' });
      await until(() => permissionRequests(turn.events).length === 2, 'both requests');
      const bashRequest = permissionRequests(turn.events).find((request) => request.title !== 'Approve the plan?')!;
      session.respondToPermission(bashRequest.requestId, 'allow_session');
      assert.equal((await bash).behavior, 'allow');
      let settled = false;
      void plan.then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled, false, 'the plan review still waits for the user');
      const review = permissionRequests(turn.events).find((request) => request.title === 'Approve the plan?')!;
      session.respondToPermission(review.requestId, 'reject_once');
      assert.equal((await plan).behavior, 'deny');
      // Session trust does not approve a later review either.
      const later = askTool(child, 'ExitPlanMode', { plan: 'Plan' });
      await until(() => permissionRequests(turn.events).length === 3, 'a later review');
      session.respondToPermission(permissionRequests(turn.events)[2].requestId, 'reject_once');
      assert.equal((await later).behavior, 'deny');
      child.result();
      await turn.done;
    } finally { await session.dispose(); }
  });

  test('an approved plan returns the chat to Default, restores the YOLO SDK mode and updates the turn stream', async () => {
    approvalMode = 'yolo';
    const { session, child, modes, notified } = await recordedSession();
    try {
      await session.setMode('plan');
      const turn = await runningScriptedTurn(session, child, undefined, 'plan');
      // Spawned in plan (or resumed), the CLI leaves plan for 'default'.
      child.status('default');
      await until(() => modes.length === 2, 'the restored SDK mode');
      assert.deepEqual(modes, ['plan', 'bypassPermissions']);
      assert.equal(session.currentModeId, 'default');
      const states = turn.events.filter((ev): ev is Extract<NormalizedEvent, { kind: 'session_state' }> => ev.kind === 'session_state');
      assert.deepEqual(states.map((ev) => ev.state.currentModeId), ['default']);
      assert.deepEqual(notified, ['plan', 'default']);
      // Its echo of the restored mode changes nothing more.
      child.status('bypassPermissions');
      child.result();
      await turn.done;
      assert.deepEqual(modes, ['plan', 'bypassPermissions']);
      assert.deepEqual(notified, ['plan', 'default']);
    } finally { await session.dispose(); }
  });

  test('an approved plan under Ask leaves the CLI\'s own default mode as it is', async () => {
    const { session, child, modes } = await recordedSession();
    try {
      await session.setMode('plan');
      const turn = await runningScriptedTurn(session, child, undefined, 'plan');
      child.status('default');
      child.result();
      await turn.done;
      assert.deepEqual(modes, ['plan']);
      assert.equal(session.currentModeId, 'default');
    } finally { await session.dispose(); }
  });

  test('the model entering plan mode itself (EnterPlanMode) shows Plan', async () => {
    const { session, child } = await recordedSession();
    try {
      const turn = await runningScriptedTurn(session, child);
      child.status('plan');
      child.result();
      await turn.done;
      assert.equal(session.currentModeId, 'plan');
      assert.ok(turn.events.some((ev) => ev.kind === 'session_state' && ev.state.currentModeId === 'plan'));
    } finally { await session.dispose(); }
  });

  test('switching back to Default restores the approval policy\'s SDK mode', async () => {
    approvalMode = 'yolo';
    const { session, modes } = await recordedSession();
    try {
      await session.setMode('plan');
      await session.setMode('default');
      assert.deepEqual(modes, ['plan', 'bypassPermissions']);
      assert.equal(session.currentModeId, 'default');
    } finally { await session.dispose(); }
  });

  test('a mode the SDK does not confirm is not shown', async () => {
    const { session, query } = await recordedSession();
    query.setPermissionMode = async () => { throw new Error('Claude permission mode change timed out'); };
    try {
      await assert.rejects(session.setMode('plan'), /timed out/);
      assert.equal(session.currentModeId, 'default');
    } finally { await session.dispose(); }
  });

  test('an Agent Run has no Plan mode', async () => {
    const { session, modes } = await recordedSession({ owner: runOwner('run-1', 'node-steer') });
    try {
      assert.equal(session.currentModeId, null);
      assert.deepEqual(session.getSessionState().availableModes, []);
      await session.setMode('default');
      await assert.rejects(session.setMode('plan'), /only in Claude chats/);
      assert.deepEqual(modes, []);
    } finally { await session.dispose(); }
  });
});
