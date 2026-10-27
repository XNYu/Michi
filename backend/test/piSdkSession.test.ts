import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiSession } from '../src/agents/pi/PiSession';
import { createPiSession, selectPiSessionKind, shouldNavigatePiTreeOnMichiBranch } from '../src/agents/pi/PiSdkSession';
import { runOwner } from './helpers/owners';

test('the unfinished SDK experiment cannot replace the real Pi session contract', async () => {
  assert.equal(selectPiSessionKind({}), 'agent-core');
  assert.equal(selectPiSessionKind({ MICHI_PI_SESSION_SDK: '1' }), 'agent-core');
  const owner = runOwner('run', 'attempt');
  const session = await createPiSession('attempt', {
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    preamble: 'preamble', cwd: '/tmp', enableFollowUps: false,
    workspaceId: null, ownerUserId: 'user', owner, profileHash: 'profile',
  });
  assert(session instanceof PiSession);
  assert.deepEqual(session.owner, owner);
  assert.equal(session.runtimeProfileHash, 'profile');
  assert.equal(typeof session.respondToPermission, 'function');
  assert.equal(typeof session.cancelPermission, 'function');
  assert.equal(typeof session.steer, 'function');
  assert.equal(shouldNavigatePiTreeOnMichiBranch(), false);
  session.destroy();
});
