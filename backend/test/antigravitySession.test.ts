import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravitySession } from '../src/agents/antigravity/AntigravitySession';
import type { NormalizedEvent } from '../src/services/chatEvents';

const FAKE_AGY = path.join(__dirname, 'fixtures', 'fakeAntigravity.js');
let tmpDir: string;
let argsFile: string;

beforeEach(() => {
  fs.chmodSync(FAKE_AGY, 0o755);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-session-'));
  argsFile = path.join(tmpDir, 'args.json');
  process.env.FAKE_AGY_ARGS_FILE = argsFile;
});

afterEach(() => {
  delete process.env.FAKE_AGY_ARGS_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function collect(session: AntigravitySession, prompt: string): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of session.send(prompt)) events.push(event);
  return events;
}

function makeSession(overrides: Partial<ConstructorParameters<typeof AntigravitySession>[0]> = {}) {
  return new AntigravitySession({
    nodeId: 'node-1',
    cwd: tmpDir,
    binaryPath: FAKE_AGY,
    logDir: path.join(tmpDir, 'logs'),
    ...overrides,
  });
}

describe('AntigravitySession', () => {
  test('streams stdout, records clean history, and captures the conversation id', async () => {
    let captured = '';
    const session = makeSession({
      model: 'Gemini 3.1 Pro (High)',
      mode: 'plan',
      firstTurnPrefix: 'SYSTEM PREFIX',
      customizationDir: path.join(tmpDir, 'customization'),
      agentName: 'michi',
      onConversationId: (id) => { captured = id; },
    });
    const events = await collect(session, 'raw user text');
    assert.equal(events.filter((event) => event.kind === 'chunk').length, 2);
    assert.equal(events.at(-1)?.kind, 'turn_end');
    assert.match(captured, /^[0-9a-f-]{36}$/i);
    assert.equal(session.getExternalConversationId(), captured);
    assert.deepEqual(session.getHistory(), [
      { role: 'user', content: 'raw user text' },
      { role: 'assistant', content: 'hello from agy\n' },
    ]);

    const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as string[];
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('Gemini 3.1 Pro (High)'));
    assert.ok(args.includes('--mode'));
    assert.ok(args.includes('plan'));
    assert.equal(args[args.lastIndexOf('--add-dir') + 1], path.join(tmpDir, 'customization'));
    assert.equal(args[args.indexOf('--agent') + 1], 'michi');
    assert.match(args[args.indexOf('--print') + 1], /^SYSTEM PREFIX\nraw user text/);
  });

  test('uses --conversation when resuming a native AGY conversation', async () => {
    const session = makeSession({
      externalConversationId: '11111111-1111-4111-8111-111111111111',
      agentName: 'michi',
    });
    const events = await collect(session, 'RECALL_TOKEN');
    const text = events.filter((event) => event.kind === 'chunk').map((event: any) => event.text).join('');
    assert.equal(text, 'AGY_PROBE_OK\n');
    const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as string[];
    assert.equal(args[args.indexOf('--conversation') + 1], '11111111-1111-4111-8111-111111111111');
    assert.equal(args.includes('--agent'), false);
  });

  test('maps default and sandbox modes to AGY public flags', async () => {
    const defaultSession = makeSession({ mode: 'default' });
    await collect(defaultSession, 'default turn');
    let args = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as string[];
    assert.equal(args.includes('--mode'), false);
    assert.equal(args.includes('--sandbox'), false);

    const sandboxSession = makeSession({ nodeId: 'node-2', mode: 'sandbox' });
    await collect(sandboxSession, 'sandbox turn');
    args = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as string[];
    assert.equal(args.includes('--mode'), false);
    assert.equal(args.includes('--sandbox'), true);
  });

  test('preserves UTF-8 characters split across stdout chunks', async () => {
    const session = makeSession();
    const events = await collect(session, 'SPLIT_UTF8');
    const text = events
      .filter((event) => event.kind === 'chunk')
      .map((event: any) => event.text)
      .join('');
    assert.equal(text, '天空是蓝色的。\n');
    assert.doesNotMatch(text, /�/);
  });

  test('cancel terminates the process group and yields a cancelled turn_end', async () => {
    const session = makeSession();
    const events: NormalizedEvent[] = [];
    for await (const event of session.send('SLOW_TURN')) {
      events.push(event);
      if (event.kind === 'chunk') session.cancel();
    }
    const end = events.at(-1);
    assert.equal(end?.kind, 'turn_end');
    assert.equal((end as any).stopReason, 'cancelled');
  });

  test('nonzero AGY exit surfaces a useful error', async () => {
    const session = makeSession();
    await assert.rejects(async () => {
      for await (const _event of session.send('FAIL_TURN')) { /* drain */ }
    }, /fake agy failure/);
  });
});
