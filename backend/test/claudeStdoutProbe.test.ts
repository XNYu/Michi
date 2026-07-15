import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClaudeStdoutHandler,
  type ClaudeStdoutProbeDeps,
} from '../src/agents/claude/claudeStdoutProbe';

describe('createClaudeStdoutHandler', () => {
  test('forwards chunks without consulting the probe clock when disabled', () => {
    const forwarded: string[] = [];
    let nowCalls = 0;
    const deps: ClaudeStdoutProbeDeps = {
      enabled: () => false,
      now: () => {
        nowCalls += 1;
        return 0;
      },
      mark: () => assert.fail('disabled probe must not emit marks'),
    };

    const onChunk = (chunk: string) => forwarded.push(chunk);
    const handleStdout = createClaudeStdoutHandler(
      onChunk,
      { sessionId: 'session-1', nodeId: 'node-1' },
      deps,
    );

    assert.equal(handleStdout, onChunk);
    handleStdout('first\n');
    handleStdout('second\n');

    assert.deepEqual(forwarded, ['first\n', 'second\n']);
    assert.equal(nowCalls, 0);
  });

  test('does not let probe clock failures block stdout forwarding', () => {
    const forwarded: string[] = [];
    const deps: ClaudeStdoutProbeDeps = {
      enabled: () => true,
      now: () => {
        throw new Error('diagnostic clock failed');
      },
      mark: () => assert.fail('mark must not run without timing metadata'),
    };
    const handleStdout = createClaudeStdoutHandler(
      (chunk) => forwarded.push(chunk),
      { sessionId: 'session-clock-failure', nodeId: 'node-clock-failure' },
      deps,
    );

    assert.doesNotThrow(() => handleStdout('still delivered\n'));
    assert.deepEqual(forwarded, ['still delivered\n']);
  });

  test('does not let diagnostic sink failures block stdout forwarding', () => {
    const forwarded: string[] = [];
    const deps: ClaudeStdoutProbeDeps = {
      enabled: () => true,
      now: () => 100,
      mark: () => {
        throw new Error('diagnostic sink failed');
      },
    };
    const handleStdout = createClaudeStdoutHandler(
      (chunk) => forwarded.push(chunk),
      { sessionId: 'session-failure', nodeId: 'node-failure' },
      deps,
    );

    assert.doesNotThrow(() => handleStdout('still delivered\n'));
    assert.deepEqual(forwarded, ['still delivered\n']);
  });

  test('records each data event and the gap between consecutive events', () => {
    const forwarded: string[] = [];
    const marks: Array<{ stage: string; meta?: Record<string, unknown> }> = [];
    const times = [100, 1112.34];
    const deps: ClaudeStdoutProbeDeps = {
      enabled: () => true,
      now: () => times.shift() ?? assert.fail('unexpected clock read'),
      mark: (stage, meta) => marks.push({ stage, meta }),
    };

    const handleStdout = createClaudeStdoutHandler(
      (chunk) => forwarded.push(chunk),
      { sessionId: 'session-2', nodeId: 'node-2' },
      deps,
    );

    handleStdout('one\n');
    handleStdout('二\nthree\n');

    assert.deepEqual(forwarded, ['one\n', '二\nthree\n']);
    assert.deepEqual(marks, [
      {
        stage: 'claude:stdout_data',
        meta: {
          sessionId: 'session-2',
          nodeId: 'node-2',
          sequence: 1,
          bytes: 4,
          lines: 1,
        },
      },
      {
        stage: 'claude:stdout_data',
        meta: {
          sessionId: 'session-2',
          nodeId: 'node-2',
          sequence: 2,
          bytes: 10,
          lines: 2,
          gapMs: 1012.3,
        },
      },
    ]);
  });
});
