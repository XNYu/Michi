import { assistantToolProfile } from '../src/assistant/policy';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiRuntime } from '../src/agents/pi/PiRuntime';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { clearAllSessions, getSession } from '../src/agents/sessionRegistry';
import { chatOwner, runOwner } from './helpers/owners';

const bridge = { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null };

test('Pi fresh and loaded sessions honor follow-up options without mutating an acquired live session', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pi-session-options-'));
  configureRuntimeDeps({
    dataDir,
    historyStore: {
      getNode: () => null, listMessages: () => [], getWorkspace: () => null,
      getWorkspaceInstructions: () => null, hasGrant: () => false, grantPermission: () => {},
    },
    agentConfig: {
      getAgentConfig: () => ({ runtime: 'pi', provider: 'test', modelByRuntime: {}, reasoningByRuntime: {} }),
      resolveModel: () => '', resolveReasoning: () => undefined,
    },
  });
  const runtime = new PiRuntime(bridge);
  t.after(async () => {
    await runtime.shutdown();
    clearAllSessions();
    __resetRuntimeDeps();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  for (const enabled of [false, true, undefined]) {
    const expected = enabled !== false;
    const freshId = `fresh-${enabled}`;
    const loadedId = `loaded-${enabled}`;
    const owner = (attemptId: string) => runOwner('run-1', attemptId);
    const fresh = await runtime.newSession({ sessionId: freshId, owner: owner(freshId), cwd: dataDir, enableFollowUps: enabled });
    const loaded = await runtime.loadSession({ sessionId: loadedId, owner: owner(loadedId), cwd: dataDir, enableFollowUps: enabled });
    for (const session of [fresh, loaded]) {
      assert.equal((session as any).enableFollowUps, expected);
      assert.equal((session as any).preamble.includes('[FOLLOW-UP 1/3:'), expected);
      assert.equal(await runtime.loadSession({
        sessionId: session.id, owner: owner(session.id), cwd: dataDir, enableFollowUps: !expected,
      }), session);
      assert.equal((session as any).enableFollowUps, expected, 'acquiring an existing session preserves its configuration');
    }
    assert.match((fresh as any).firstUserGlue, /\[TITLE:/, 'ordinary fresh chats retain title guidance');

    const wrongOwner = chatOwner(loadedId);
    await assert.rejects(runtime.loadSession({ sessionId: loadedId, owner: wrongOwner, cwd: dataDir }), /different owner/);
    await assert.rejects(runtime.releaseSession(loadedId, wrongOwner), /Owner mismatch/);
    assert.equal(getSession(loadedId), loaded, 'wrong-owner release preserves the real session');
    await runtime.releaseSession(loadedId, owner(loadedId));
    assert.equal(getSession(loadedId), undefined);
  }

  for (const enabled of [false, true, undefined]) {
    const fresh = await runtime.newSession({
      sessionId: `assistant-fresh-${enabled}`, cwd: dataDir,
      enableFollowUps: enabled, toolProfile: assistantToolProfile(),
    });
    const loaded = await runtime.loadSession({
      sessionId: `assistant-loaded-${enabled}`, cwd: dataDir,
      enableFollowUps: enabled, toolProfile: assistantToolProfile(),
    });
    for (const session of [fresh, loaded]) {
      assert.equal((session as any).enableFollowUps, false, 'Michi never requests follow-up metadata');
      assert.equal((session as any).firstUserGlue, '', 'Michi never receives first-turn title instructions');
      assert.doesNotMatch((session as any).preamble, /\[(?:TITLE|FOLLOW-UP|BRANCH-OVERVIEW)[ :]/);
    }
  }
});
