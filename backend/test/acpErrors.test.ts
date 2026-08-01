import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ACPError, ACPProcessExitedError, ACPNotRunningError } from '../src/services/acpClient';
import { classifyAcpError, isRetryable, needsRespawn, toErrorKind } from '../src/agents/kiro/acpErrors';

/**
 * kiro-cli collapses every runtime failure into JSON-RPC `-32603 "Internal error"`;
 * the only discriminator is the `rpcData` string. These fixtures are the exact
 * strings observed in ~/.michi/logs/backend.log plus the error taxonomy baked
 * into the kiro-cli binary (aws-smithy transport + CodeWhisperer/Q service).
 */
function rpcErr(rpcData: unknown): ACPError {
  return new ACPError('Internal error', {
    method: 'session/prompt',
    sessionId: 's1',
    rpcCode: -32603,
    rpcData,
  });
}

describe('classifyAcpError — connection class (respawn required)', () => {
  test('dispatch failure (SDK connection layer)', () => {
    const err = rpcErr(
      'Encountered an error in the response stream: An unknown error occurred: dispatch failure',
    );
    assert.equal(classifyAcpError(err), 'connection');
    assert.equal(needsRespawn('connection'), true);
    assert.equal(isRetryable('connection'), true);
  });

  test('stream timed out receiving the response (StalledStreamProtection)', () => {
    const err = rpcErr(
      'Encountered an error in the response stream: The stream timed out receiving the response after 239767ms (request_id: f55a4e74)',
    );
    assert.equal(classifyAcpError(err), 'connection');
  });

  test('ACPProcessExitedError → connection', () => {
    assert.equal(classifyAcpError(new ACPProcessExitedError('ACP process exited with code 1')), 'connection');
  });

  test('ACPNotRunningError → connection', () => {
    assert.equal(classifyAcpError(new ACPNotRunningError('ACP process is not running')), 'connection');
  });
});

describe('classifyAcpError — transient class (same-session resend)', () => {
  test('throttled by the service (contains "response stream" but throttle wins)', () => {
    const err = rpcErr(
      'Encountered an error in the response stream: The request was throttled by the service (request_id: f6c94bd7)',
    );
    assert.equal(classifyAcpError(err), 'transient');
    assert.equal(isRetryable('transient'), true);
    assert.equal(needsRespawn('transient'), false);
  });

  test('Kiro failed to generate a response', () => {
    assert.equal(classifyAcpError(rpcErr('Kiro failed to generate a response')), 'transient');
  });

  test('ModelTemporarilyUnavailable', () => {
    assert.equal(classifyAcpError(rpcErr('ModelTemporarilyUnavailable')), 'transient');
  });

  test('InternalServerError', () => {
    assert.equal(classifyAcpError(rpcErr('InternalServerException: something went wrong')), 'transient');
  });
});

describe('classifyAcpError — auth class (no retry, re-login)', () => {
  for (const marker of [
    'ExpiredTokenException',
    'InvalidGrantException',
    'UnauthorizedClientException',
    'NotAuthorizedException',
  ]) {
    test(marker, () => {
      assert.equal(classifyAcpError(rpcErr(marker)), 'auth');
      assert.equal(isRetryable('auth'), false);
      assert.equal(needsRespawn('auth'), false);
    });
  }
});

describe('classifyAcpError — generic class (no retry, surface raw)', () => {
  test('ValidationError', () => {
    assert.equal(classifyAcpError(rpcErr('ValidationError: invalid parameter')), 'generic');
    assert.equal(isRetryable('generic'), false);
  });

  test('MonthlyRequestCount quota → generic (not auth, not retry)', () => {
    assert.equal(classifyAcpError(rpcErr('MonthlyRequestCount limit reached')), 'generic');
  });

  test('test-provider stub object rpcData → generic', () => {
    assert.equal(classifyAcpError(rpcErr({ provider: 'test-provider', requestId: 'req-123' })), 'generic');
  });

  test('plain Error with no ACP details → generic', () => {
    assert.equal(classifyAcpError(new Error('boom')), 'generic');
  });

  test('non-error value → generic', () => {
    assert.equal(classifyAcpError('nope'), 'generic');
    assert.equal(classifyAcpError(undefined), 'generic');
  });
});

describe('toErrorKind — UI-facing collapse to 3 kinds', () => {
  test('connection + transient both surface as connection banner', () => {
    assert.equal(toErrorKind('connection'), 'connection');
    assert.equal(toErrorKind('transient'), 'connection');
  });
  test('auth → auth', () => {
    assert.equal(toErrorKind('auth'), 'auth');
  });
  test('generic → generic', () => {
    assert.equal(toErrorKind('generic'), 'generic');
  });
});
