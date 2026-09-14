import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KiroSession } from '../src/agents/kiro/KiroSession';
import type { KiroRuntime } from '../src/agents/kiro/KiroRuntime';
import { ACPError, ACPProcessExitedError } from '../src/services/acpClient';

type Update = Record<string, unknown>;

/**
 * Build a mock runtime whose client.prompt() plays a scripted sequence of
 * "attempts" — each attempt is either an array of updates to yield or an Error
 * to throw partway. Records recoverSession calls so tests can assert respawn.
 */
function scriptedRuntime(attempts: Array<Update[] | Error>) {
  let call = 0;
  const recoverCalls: Array<{ sid: string; cwd: string }> = [];
  const client = {
    async *prompt() {
      const script = attempts[Math.min(call, attempts.length - 1)];
      call += 1;
      if (script instanceof Error) {
        // Yield nothing, then fail — models the zero-visible-output case.
        throw script;
      }
      for (const u of script) yield u;
    },
  };
  const runtime = {
    ensureClient: async () => client,
    getCurrentMode: () => null,
    getCurrentModel: () => null,
    recoverSession: async (sid: string, cwd: string) => {
      recoverCalls.push({ sid, cwd });
      return true;
    },
  } as unknown as KiroRuntime;
  return { runtime, recoverCalls, calls: () => call };
}

function connErr(): ACPError {
  return new ACPError('Internal error', {
    method: 'session/prompt',
    rpcCode: -32603,
    rpcData: 'Encountered an error in the response stream: An unknown error occurred: dispatch failure',
  });
}

describe('KiroSession connection-class auto-retry', () => {
  for (const error of [connErr(), new ACPError('failed to generate a response')]) {
    it(`does not retry an explicitly cancelled turn after ${error.rpcData ?? error.message}`, async () => {
      let fail!: (err: Error) => void;
      let ready!: () => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      let calls = 0;
      let recoveries = 0;
      const client = {
        async *prompt() {
          calls += 1;
          if (calls === 1) {
            const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
            ready();
            await pending;
          }
          yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
        },
        async cancel() { fail(error); },
      };
      const runtime = {
        ensureClient: async () => client, getClient: () => client,
        recoverSession: async () => { recoveries += 1; return true; },
      } as unknown as KiroRuntime;
      const session = new KiroSession('cancel-node', 'cancel-sid', runtime, '/tmp');
      const result = (async () => {
        const events = [];
        for await (const event of session.send('stop this work')) events.push(event);
        return events;
      })();
      await started;
      await session.cancel();
      const events = await result;
      assert.equal(calls, 1, 'cancelled work must not be re-sent');
      assert.equal(recoveries, 0, 'cancel must not restart the shared ACP process');
      assert.deepEqual(events.at(-1), { kind: 'turn_end', stopReason: 'cancelled' });
      for await (const _event of session.send('new work')) { /* drain */ }
      assert.equal(calls, 2, 'cancellation must not poison the next turn');
    });
  }

  it('respawns + resends once on dispatch failure with zero visible output', async () => {
    const { runtime, recoverCalls } = scriptedRuntime([
      connErr(),
      [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Recovered answer.' } },
        { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
      ],
    ]);
    const session = new KiroSession('node-1', 'sid-1', runtime, '/tmp');

    const chunks: string[] = [];
    for await (const ev of session.send('hi')) {
      if (ev.kind === 'chunk') chunks.push(ev.text);
    }

    assert.equal(chunks.join(''), 'Recovered answer.');
    assert.deepEqual(recoverCalls, [{ sid: 'sid-1', cwd: '/tmp' }]);
    // History has exactly one assistant turn — no duplication from the retry.
    assert.deepEqual(session.getHistory(), [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Recovered answer.' },
    ]);
  });

  it('ACPProcessExitedError also triggers respawn + resend', async () => {
    const { runtime, recoverCalls } = scriptedRuntime([
      new ACPProcessExitedError('ACP process exited with code 1'),
      [{ sessionUpdate: 'turn_end', stopReason: 'end_turn' }],
    ]);
    const session = new KiroSession('node-2', 'sid-2', runtime, '/tmp');

    const events = [];
    for await (const ev of session.send('hi')) events.push(ev);

    assert.equal(recoverCalls.length, 1);
    assert.deepEqual(events.at(-1), { kind: 'turn_end', stopReason: 'end_turn' });
  });

  it('does NOT retry once visible output was already streamed', async () => {
    // First attempt yields a chunk, THEN dies. Retrying would duplicate text.
    const partialThenDie = {
      async *prompt() {
        yield { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Half...' } };
        throw connErr();
      },
    };
    let recoverCount = 0;
    const runtime = {
      ensureClient: async () => partialThenDie,
      getCurrentMode: () => null,
      getCurrentModel: () => null,
      recoverSession: async () => {
        recoverCount += 1;
        return true;
      },
    } as unknown as KiroRuntime;
    const session = new KiroSession('node-3', 'sid-3', runtime, '/tmp');

    const chunks: string[] = [];
    let thrown: unknown;
    try {
      for await (const ev of session.send('hi')) {
        if (ev.kind === 'chunk') chunks.push(ev.text);
      }
    } catch (e) {
      thrown = e;
    }

    assert.equal(recoverCount, 0, 'must not recover after visible output');
    assert.equal(chunks.join(''), 'Half...');
    assert.equal((thrown as { acpErrorKind?: string }).acpErrorKind, 'connection');
  });

  it('auth error is rethrown immediately with acpErrorKind=auth, no retry', async () => {
    const authErr = new ACPError('Internal error', {
      rpcCode: -32603,
      rpcData: 'ExpiredTokenException: token has expired',
    });
    const { runtime, recoverCalls } = scriptedRuntime([authErr]);
    const session = new KiroSession('node-4', 'sid-4', runtime, '/tmp');

    let thrown: unknown;
    try {
      for await (const _ev of session.send('hi')) { /* drain */ }
    } catch (e) {
      thrown = e;
    }

    assert.equal(recoverCalls.length, 0);
    assert.equal((thrown as { acpErrorKind?: string }).acpErrorKind, 'auth');
  });

  it('gives up after a second consecutive failure (only one retry)', async () => {
    const { runtime, recoverCalls } = scriptedRuntime([connErr(), connErr()]);
    const session = new KiroSession('node-5', 'sid-5', runtime, '/tmp');

    let thrown: unknown;
    try {
      for await (const _ev of session.send('hi')) { /* drain */ }
    } catch (e) {
      thrown = e;
    }

    assert.equal(recoverCalls.length, 1, 'exactly one retry attempt');
    assert.equal((thrown as { acpErrorKind?: string }).acpErrorKind, 'connection');
  });

  it('surfaces original error when recovery itself fails', async () => {
    let recoverCount = 0;
    const dying = {
      async *prompt() {
        throw connErr();
      },
    };
    const runtime = {
      ensureClient: async () => dying,
      getCurrentMode: () => null,
      getCurrentModel: () => null,
      recoverSession: async () => {
        recoverCount += 1;
        return false; // recovery failed
      },
    } as unknown as KiroRuntime;
    const session = new KiroSession('node-6', 'sid-6', runtime, '/tmp');

    let thrown: unknown;
    try {
      for await (const _ev of session.send('hi')) { /* drain */ }
    } catch (e) {
      thrown = e;
    }

    assert.equal(recoverCount, 1);
    assert.equal((thrown as { acpErrorKind?: string }).acpErrorKind, 'connection');
  });
});

describe('KiroSession agent_run owner retry behavior', () => {
  it('agent_run owner does NOT auto-retry — surfaces connection error immediately', async () => {
    let recoverCount = 0;
    const { runtime } = scriptedRuntime([connErr()]);
    // Override recoverSession to track calls.
    (runtime as any).recoverSession = async () => {
      recoverCount += 1;
      return true;
    };

    const session = new KiroSession('attempt-1', 'sid-run', runtime, '/tmp', {
      owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
    });

    let thrown: unknown;
    try {
      for await (const _ev of session.send('task instructions')) { /* drain */ }
    } catch (e) {
      thrown = e;
    }

    assert.ok(thrown, 'should throw the connection error');
    assert.equal(recoverCount, 0, 'agent_run owner must NOT trigger auto-recovery');
    assert.equal((thrown as { acpErrorKind?: string }).acpErrorKind, undefined,
      'agent_run path does not decorate acpErrorKind (raw error surfaced)');
  });

  it('agent_run owner surfaces ACPProcessExitedError without retry', async () => {
    const { runtime, recoverCalls } = scriptedRuntime([
      new ACPProcessExitedError('ACP process exited with code 1'),
    ]);
    const session = new KiroSession('attempt-2', 'sid-run-2', runtime, '/tmp', {
      owner: { kind: 'agent_run', runId: 'run-2', attemptId: 'attempt-2' },
    });

    let thrown: unknown;
    try {
      for await (const _ev of session.send('task')) { /* drain */ }
    } catch (e) {
      thrown = e;
    }

    assert.ok(thrown instanceof ACPProcessExitedError);
    assert.equal(recoverCalls.length, 0, 'no recovery for agent_run owner');
  });

  it('chat_node owner still retries on same error (backward compat)', async () => {
    const { runtime, recoverCalls } = scriptedRuntime([
      connErr(),
      [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } },
        { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
      ],
    ]);
    const session = new KiroSession('node-chat', 'sid-chat', runtime, '/tmp', {
      owner: { kind: 'chat_node', nodeId: 'node-chat' },
    });

    const chunks: string[] = [];
    for await (const ev of session.send('hi')) {
      if (ev.kind === 'chunk') chunks.push(ev.text);
    }

    assert.equal(chunks.join(''), 'OK');
    assert.equal(recoverCalls.length, 1, 'chat owner should retry with recovery');
  });
});
