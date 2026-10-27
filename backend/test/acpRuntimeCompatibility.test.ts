import { michiTestHost } from './helpers/michiTestHost';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as kiro from 'michi-runtime/internal/adapters/acp/errors';
import * as generic from '../src/services/acp/client';
import { classifyAcpError } from 'michi-runtime/internal/adapters/kiro/acpErrors';
import { AcpSession } from '../src/agents/acp/AcpSession';
import { KiroSession } from 'michi-runtime/internal/adapters/kiro/KiroSession';

test('Kiro and generic ACP preserve shared error identities', () => {
  assert.equal(kiro.ACPError, generic.ACPError);
  assert.equal(kiro.ACPNotRunningError, generic.ACPNotRunningError);
  assert.equal(kiro.ACPProcessExitedError, generic.ACPProcessExitedError);
  assert.equal(classifyAcpError(new generic.ACPNotRunningError('not running')), 'connection');
  assert.equal(classifyAcpError(new generic.ACPError('Internal error', {
    rpcData: 'ExpiredTokenException',
  })), 'auth');
});

test('public ACP sessions retain their runtime identity alongside Kiro', () => {
  for (const id of ['cursor', 'grok']) {
    const session = new AcpSession('node', 'native', { id } as any, '/tmp');
    assert.equal(session.runtimeId, id);
  }
  const session = new KiroSession('node', 'native', { id: 'kiro', host: michiTestHost() } as any, '/tmp');
  assert.equal(session.runtimeId, 'kiro');
});
