import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PiSdkSession,
  selectPiSessionKind,
  shouldNavigatePiTreeOnMichiBranch,
  tryLoadPiCodingAgent,
} from '../src/agents/pi/PiSdkSession';
import { isPiSessionSdkEnabled } from '../src/agents/pi/piSdkFlag';

describe('Pi SDK factory', () => {
  test('flag off selects agent-core', () => {
    assert.equal(isPiSessionSdkEnabled({}), false);
    assert.equal(selectPiSessionKind({}), 'agent-core');
    assert.equal(selectPiSessionKind({ MICHI_PI_SESSION_SDK: '1' }), 'sdk');
  });

  test('Michi branch never navigates the parent Pi tree', () => {
    assert.equal(shouldNavigatePiTreeOnMichiBranch(), false);
  });

  test('missing coding-agent package is a documented fallback', async () => {
    const loaded = await tryLoadPiCodingAgent();
    assert.equal(loaded, null);
  });

  test('SDK session exposes steer only when adapter is present', async () => {
    const navigateTree = () => {
      throw new Error('parent tree must not be mutated');
    };
    const session = new PiSdkSession('child', {
      bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
      preamble: 'preamble',
      cwd: '/tmp',
      enableFollowUps: true,
      workspaceId: null,
      ownerUserId: null,
      parentChatId: 'parent',
    }, {
      steer: async () => {},
      followUp: async () => {},
      compact: async () => {},
      abort: () => {},
      navigateTree,
    });
    assert.equal((await session.steer('inject')).accepted, true);
    assert.equal((await session.followUp('later')).accepted, true);
    assert.equal((await session.compact()).started, true);
    assert.equal(shouldNavigatePiTreeOnMichiBranch(), false);
    session.destroy();
  });

  test('SDK session without adapter stays invisible for steer', async () => {
    const session = new PiSdkSession('n1', {
      bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
      preamble: 'preamble',
      cwd: '/tmp',
      enableFollowUps: true,
      workspaceId: null,
      ownerUserId: null,
    });
    assert.equal((await session.steer('x')).accepted, false);
    session.destroy();
  });
});
