import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AcpAgentSession } from 'michi-runtime/internal/adapters/kiro/AcpAgentSession';
import type { AcpAgentRuntime } from 'michi-runtime/internal/adapters/kiro/AcpAgentRuntime';
import { ACPError, ACPProcessExitedError } from 'michi-runtime/internal/adapters/kiro/acpClient';
import { michiTestHost } from './helpers/michiTestHost';
import { runOwner } from './helpers/owners';

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
    host: michiTestHost(),
    ensureClient: async () => client,
    getCurrentMode: () => null,
    getCurrentModel: () => null,
    recoverSession: async (sid: string, cwd: string) => {
      recoverCalls.push({ sid, cwd });
      return true;
    },
  } as unknown as AcpAgentRuntime;
  return { runtime, recoverCalls, calls: () => call };
}

function connErr(): ACPError {
  return new ACPError('Internal error', {
    method: 'session/prompt',
    rpcCode: -32603,
    rpcData: 'Encountered an error in the response stream: An unknown error occurred: dispatch failure',
  });
}

describe('AcpAgentSession connection-class auto-retry', () => {
  for (const error of [connErr(), new ACPError('failed to generate a response')]) {
  }

  it('gives up after a second consecutive failure (only one retry)', async () => {
    const { runtime, recoverCalls } = scriptedRuntime([connErr(), connErr()]);
    const session = new AcpAgentSession('node-5', 'sid-5', runtime, '/tmp');

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
      host: michiTestHost(),
      ensureClient: async () => dying,
      getCurrentMode: () => null,
      getCurrentModel: () => null,
      recoverSession: async () => {
        recoverCount += 1;
        return false; // recovery failed
      },
    } as unknown as AcpAgentRuntime;
    const session = new AcpAgentSession('node-6', 'sid-6', runtime, '/tmp');

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

describe('AcpAgentSession agent_run owner retry behavior', () => {
  it('agent_run owner surfaces ACPProcessExitedError without retry', async () => {
    const { runtime, recoverCalls } = scriptedRuntime([
      new ACPProcessExitedError('ACP process exited with code 1'),
    ]);
    const session = new AcpAgentSession('attempt-2', 'sid-run-2', runtime, '/tmp', {
      owner: runOwner('run-2', 'attempt-2'),
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
});

describe('AcpAgentSession Pages turn context and attribution', () => {
  it('sends manifest context only to the model and exposes attribution only for the owning send', async () => {
    let activeGetter: (() => { turnId: string; assistantId: string } | null) | undefined;
    let modelText = '';
    let duringPrompt: { turnId: string; assistantId: string } | null = null;
    const client = {
      async *prompt(_sid: string, text: string) {
        modelText = text;
        duringPrompt = activeGetter?.() ?? null;
        yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
      },
    };
    const runtime = {
      host: michiTestHost(),
      ensureClient: async () => client,
      getCurrentMode: () => null,
      getCurrentModel: () => null,
      beginMcpSessionTurn: (_sid: string, getter: typeof activeGetter) => {
        activeGetter = getter;
        return () => { activeGetter = undefined; };
      },
    } as unknown as AcpAgentRuntime;
    const session = new AcpAgentSession('node-pages', 'sid-pages', runtime, '/tmp', {
      owner: { mode: 'interactive', key: 'node-pages' },
    });

    for await (const _event of session.send('raw user text', {
      turnId: 'turn-canonical',
      assistantMessageId: 'assistant-canonical',
      pageContext: 'Michi Pages manifest (JSON): {}',
    })) { /* drain */ }

    assert.match(modelText, /^Michi Pages manifest \(JSON\): \{\}\n\n---\n\nraw user text/);
    assert.deepEqual(duringPrompt, { turnId: 'turn-canonical', assistantId: 'assistant-canonical' });
    assert.deepEqual(session.getHistory(), [{ role: 'user', content: 'raw user text' }]);
    assert.equal(session.getActivePageTurnAttribution(), null);
    assert.equal(activeGetter, undefined);
  });

  it('sends the Michi Memory block ahead of the Pages context, after the first-message preamble, and keeps it out of history', async () => {
    const prompts: string[] = [];
    const client = {
      async *prompt(_sid: string, text: string) {
        prompts.push(text);
        yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
      },
    };
    const runtime = {
      host: michiTestHost(),
      ensureClient: async () => client,
      getCurrentMode: () => null,
      getCurrentModel: () => null,
    } as unknown as AcpAgentRuntime;
    const session = new AcpAgentSession('node-memory', 'sid-memory', runtime, '/tmp', {
      owner: { mode: 'interactive', key: 'node-memory' },
    });
    session.primeFirstMessage('FIRST-MESSAGE PREAMBLE');

    for await (const _event of session.send('first question', {
      memoryContext: '<michi-memory>\n- Reply in Chinese. (preference)\n</michi-memory>',
      pageContext: 'Michi Pages manifest (JSON): {}',
    })) { /* drain */ }
    for await (const _event of session.send('second question')) { /* drain */ }

    assert.match(prompts[0]!, /^FIRST-MESSAGE PREAMBLE\n<michi-memory>\n- Reply in Chinese\. \(preference\)\n<\/michi-memory>\n\n---\n\nMichi Pages manifest \(JSON\): \{\}\n\n---\n\nfirst question/);
    assert.match(prompts[1]!, /^second question/, 'a turn without a block sends none');
    assert.deepEqual(session.getHistory().filter((m) => m.role === 'user').map((m) => m.content), ['first question', 'second question']);
  });
});

describe('AcpAgentSession auto-retry is visible to the UI', () => {
  it('transient retry reads as "model unavailable", not "cannot reach"', async () => {
    const { runtime } = scriptedRuntime([
      new ACPError('failed to generate a response'),
      [{ sessionUpdate: 'turn_end', stopReason: 'end_turn' }],
    ]);
    const session = new AcpAgentSession('vis-2', 'sid-vis-2', runtime, '/tmp');

    const events = [];
    for await (const ev of session.send('hi')) events.push(ev);

    const retryStart = events.find((e) => e.kind === 'retry_start') as
      | { kind: 'retry_start'; detail?: string }
      | undefined;
    assert.ok(retryStart, 'transient failure must also surface a retry_start');
    assert.equal(
      retryStart.detail,
      'The selected model is temporarily unavailable. Retrying (attempt 1)…',
      'transient retry detail describes model availability without claiming Kiro is unreachable',
    );
  });
});
