import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { executeBash } from '../src/agents/tools/bash';
import * as processes from '../src/agents/processTree';

test('bash abort before dispatch never creates a child', async (t) => {
  t.mock.method(processes, 'spawnAgentProcess', () => { assert.fail('must not spawn'); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeBash({ command: 'echo should-not-run' }, '/tmp', { signal: controller.signal }), { name: 'AbortError' });
});

for (const ignoreTerm of [false, true]) {
  test(`bash cancellation retires its real process group${ignoreTerm ? ' with forced escalation' : ''}`, { skip: process.platform === 'win32' }, async (t) => {
    const spawn = processes.spawnAgentProcess;
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    t.mock.method(processes, 'spawnAgentProcess', (...args: Parameters<typeof spawn>) => {
      child = spawn(...args);
      closed = once(child, 'close');
      child.stdout.on('data', () => ready());
      return child;
    });
    t.after(() => { if (child?.pid) processes.killProcessTree(child.pid, 'SIGKILL'); });
    const controller = new AbortController();
    const command = `${ignoreTerm ? "trap '' TERM; " : ''}echo ready; sleep 60 & wait`;
    const stopped = assert.rejects(executeBash({ command }, '/tmp', { signal: controller.signal }), { name: 'AbortError' });
    await started;
    const at = Date.now();
    controller.abort();
    await stopped;
    await closed;
    assert.ok(Date.now() - at < 4_000, 'cancel has a bounded escalation path');
    assert.ok(child?.exitCode !== null || child?.signalCode !== null);
  });
}
