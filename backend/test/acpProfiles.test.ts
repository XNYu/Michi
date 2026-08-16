import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createKiroProfile } from '../src/services/acp/profiles/kiro';
import {
  createCursorProfile,
  mapCursorPermissionKind,
  mapCursorPermissionOptions,
  cursorAskQuestionResult,
  cursorHasAuth,
  findCursorCli,
  isGrokAgentBinary,
} from '../src/services/acp/profiles/cursor';
import {
  createGrokProfile,
  selectGrokAuthMethod,
  grokSpawnArgs,
  isOfficialGrokCli,
} from '../src/services/acp/profiles/grok';
import { AcpClient } from '../src/services/acpClient';
import {
  acpShouldAttachMcp,
  acpSupportsHttpMcp,
  acpSupportsImagePrompt,
  acpSupportsLoadSession,
} from '../src/services/acp/types';
import { KiroSession } from '../src/agents/kiro/KiroSession';

describe('Kiro ACP profile (bit-identical contract)', () => {
  test('spawns acp -a, uses protocolVersion 2025-01-01, and has no authenticate step', () => {
    const profile = createKiroProfile({ binaryPath: '/bin/false', cwd: '/tmp' });
    assert.deepEqual(profile.spawnArgs, ['acp', '-a']);
    assert.equal(profile.protocolVersion, '2025-01-01');
    assert.equal((profile as { buildAuthenticate?: unknown }).buildAuthenticate, undefined);
    assert.deepEqual(profile.clientInfo, { name: 'michi', version: '1.0.0' });
    assert.deepEqual(profile.clientCapabilities, {});
    assert.equal(profile.runtimeId, 'kiro');
    assert.equal(profile.mcpAttach, 'always');
  });

  test('forwards --model on spawn when a model is set', () => {
    const profile = createKiroProfile({ binaryPath: '/bin/false', cwd: '/tmp', model: 'claude-sonnet' });
    assert.deepEqual(profile.spawnArgs, ['acp', '-a', '--model', 'claude-sonnet']);
  });
});

describe('Cursor ACP profile', () => {
  test('spawns agent acp, protocolVersion 1, authenticate cursor_login', () => {
    const profile = createCursorProfile({ binaryPath: '/bin/false', cwd: '/tmp', skipPreflight: true });
    assert.deepEqual(profile.spawnArgs, ['acp']);
    assert.equal(profile.protocolVersion, 1);
    assert.deepEqual(profile.buildAuthenticate({}), { methodId: 'cursor_login' });
    assert.equal(profile.runtimeId, 'cursor');
    assert.deepEqual(profile.clientCapabilities, {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    assert.equal(profile.mcpAttach, 'always');
  });

  test('maps hyphenated Cursor optionIds to Michi UI kinds and keeps optionId', () => {
    assert.equal(mapCursorPermissionKind('allow-once'), 'allow_once');
    assert.equal(mapCursorPermissionKind('allow-always'), 'allow_always');
    assert.equal(mapCursorPermissionKind('reject-once'), 'reject_once');
    const mapped = mapCursorPermissionOptions([
      { optionId: 'allow-once', name: 'Allow once' },
      { optionId: 'reject-once', name: 'Reject' },
    ]) as Array<{ optionId: string; kind: string }>;
    assert.deepEqual(mapped.map((o) => ({ optionId: o.optionId, kind: o.kind })), [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ]);
  });

  test('maps ask_question answers back to Cursor option ids', () => {
    const questions = [
      {
        id: 'q1',
        prompt: 'Which mode should I use?',
        options: [
          { id: 'agent', label: 'Agent' },
          { id: 'plan', label: 'Plan' },
        ],
      },
    ];
    assert.deepEqual(
      cursorAskQuestionResult(questions, [{ question: 'Which mode should I use?', answer: 'Agent' }]),
      { outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['agent'] }] } },
    );
    assert.deepEqual(cursorAskQuestionResult(questions, null), { outcome: { outcome: 'skipped' } });
  });

  test('treats CURSOR_API_KEY as sufficient auth', () => {
    assert.equal(cursorHasAuth({ CURSOR_API_KEY: 'k' }, '/tmp/does-not-exist'), true);
    assert.equal(cursorHasAuth({ CURSOR_AUTH_TOKEN: 't' }, '/tmp/does-not-exist'), true);
    assert.equal(cursorHasAuth({}, '/tmp/does-not-exist'), false);
  });

  test('findCursorCli prefers CURSOR_CLI_BIN, then ~/.local/bin/agent, never ~/.grok/bin/agent', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-cli-'));
    try {
      const localDir = path.join(tmp, '.local', 'bin');
      const grokDir = path.join(tmp, '.grok', 'bin');
      const pathDir = path.join(tmp, 'path');
      fs.mkdirSync(localDir, { recursive: true });
      fs.mkdirSync(grokDir, { recursive: true });
      fs.mkdirSync(pathDir, { recursive: true });
      const localAgent = path.join(localDir, 'agent');
      const grokAgent = path.join(grokDir, 'agent');
      const pathAgent = path.join(pathDir, 'agent');
      const override = path.join(tmp, 'override-agent');
      fs.writeFileSync(localAgent, '#!/bin/sh\n');
      fs.writeFileSync(grokAgent, '#!/bin/sh\n');
      fs.writeFileSync(pathAgent, '#!/bin/sh\n');
      fs.writeFileSync(override, '#!/bin/sh\n');
      fs.chmodSync(localAgent, 0o755);
      fs.chmodSync(grokAgent, 0o755);
      fs.chmodSync(pathAgent, 0o755);
      fs.chmodSync(override, 0o755);

      assert.equal(isGrokAgentBinary(grokAgent), true);
      assert.equal(isGrokAgentBinary(localAgent), false);

      assert.equal(
        findCursorCli({ CURSOR_CLI_BIN: override, PATH: grokDir }, tmp),
        override,
      );
      assert.throws(
        () => findCursorCli({ CURSOR_CLI_BIN: grokAgent, PATH: pathDir }, tmp),
        /Grok/,
      );
      assert.equal(
        findCursorCli({ PATH: `${grokDir}:${pathDir}` }, tmp),
        localAgent,
      );
      fs.unlinkSync(localAgent);
      assert.throws(
        () => findCursorCli({ PATH: grokDir }, tmp),
        /not found|Grok/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Cursor permission + ask_question dispatch', () => {
  test('permission_request kinds are underscored; respondToPermission echoes optionId', async () => {
    const client = new AcpClient(createCursorProfile({
      binaryPath: '/bin/false',
      cwd: '/tmp',
      skipPreflight: true,
    })) as any;
    const writes: string[] = [];
    client.proc = {
      stdin: {
        destroyed: false,
        write(payload: string, callback?: (error?: Error | null) => void) {
          writes.push(payload);
          callback?.(null);
          return true;
        },
      },
    };
    client.sessionQueues.set('sess-1', new (client.sessionQueues.get.constructor || Object)());
    // SessionQueue is private; reuse newSession's internal path
    client.sessionQueues.set('sess-1', {
      items: [] as any[],
      waiter: null,
      push(item: any) { this.items.push(item); },
      get() { return Promise.resolve(this.items.shift()); },
      drain() { this.items = []; },
    });

    client.dispatch({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 't1', title: 'Edit' },
        options: [{ optionId: 'allow-once', name: 'Allow once' }],
      },
    });

    const queued = client.sessionQueues.get('sess-1').items[0].update;
    assert.equal(queued.sessionUpdate, 'permission_request');
    assert.equal(queued.options[0].optionId, 'allow-once');
    assert.equal(queued.options[0].kind, 'allow_once');

    client.respondToPermission(7, 'allow-once');
    const reply = JSON.parse(writes[0].trim());
    assert.deepEqual(reply, {
      jsonrpc: '2.0',
      id: 7,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });
  });

  test('cursor/ask_question is answered via user-input and never dropped', async () => {
    const client = new AcpClient(createCursorProfile({
      binaryPath: '/bin/false',
      cwd: '/tmp',
      skipPreflight: true,
    })) as any;
    const writes: string[] = [];
    client.proc = {
      stdin: {
        destroyed: false,
        write(payload: string, callback?: (error?: Error | null) => void) {
          writes.push(payload);
          callback?.(null);
          return true;
        },
      },
    };
    client.sessionQueues.set('sess-1', {
      items: [] as any[],
      waiter: null,
      push(item: any) { this.items.push(item); },
      get() { return Promise.resolve(this.items.shift()); },
      drain() { this.items = []; },
    });

    client.dispatch({
      jsonrpc: '2.0',
      id: 42,
      method: 'cursor/ask_question',
      params: {
        sessionId: 'sess-1',
        questions: [
          {
            id: 'q1',
            prompt: 'Which mode should I use?',
            options: [
              { id: 'agent', label: 'Agent' },
              { id: 'plan', label: 'Plan' },
            ],
          },
        ],
      },
    });

    await new Promise((r) => setImmediate(r));
    const request = client.sessionQueues.get('sess-1').items[0].update;
    assert.equal(request.sessionUpdate, 'user_input_request');
    assert.equal(request.questions[0].question, 'Which mode should I use?');

    const ok = client.respondToUserInput(request.requestId, [
      { question: 'Which mode should I use?', answer: 'Agent' },
    ]);
    assert.equal(ok, true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const reply = writes.map((w) => JSON.parse(w.trim())).find((m) => m.id === 42);
    assert.ok(reply, 'ask_question must receive a JSON-RPC reply');
    assert.deepEqual(reply.result, {
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['agent'] }],
      },
    });
  });
});

describe('Grok ACP profile', () => {
  test('prefers root --no-auto-update agent stdio', () => {
    assert.deepEqual(grokSpawnArgs(), ['--no-auto-update', 'agent', 'stdio']);
    assert.deepEqual(grokSpawnArgs('no such flag'), ['agent', 'stdio']);
    const profile = createGrokProfile({ binaryPath: '/bin/false', cwd: '/tmp', skipPreflight: true });
    assert.deepEqual(profile.spawnArgs, ['--no-auto-update', 'agent', 'stdio']);
    assert.equal(profile.protocolVersion, 1);
    assert.equal(profile.runtimeId, 'grok');
    assert.deepEqual(profile.clientCapabilities, {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    assert.equal(profile.mcpAttach, 'always');
  });

  test('prefers cached_token after login even when XAI_API_KEY is set', () => {
    assert.equal(
      selectGrokAuthMethod([{ id: 'cached_token' }, { id: 'grok.com' }, { id: 'xai.api_key' }], { XAI_API_KEY: 'sk' }),
      'cached_token',
    );
    assert.equal(
      selectGrokAuthMethod([{ id: 'xai.api_key' }, { id: 'cached_token' }], { XAI_API_KEY: 'sk' }),
      'cached_token',
    );
  });

  test('uses xai.api_key only when cached_token is absent and the key is set', () => {
    assert.equal(
      selectGrokAuthMethod([{ id: 'xai.api_key' }, { id: 'grok.com' }], { XAI_API_KEY: 'sk' }),
      'xai.api_key',
    );
  });

  test('falls back to grok.com without requiring xai.api_key', () => {
    assert.equal(
      selectGrokAuthMethod([{ id: 'grok.com' }], {}),
      'grok.com',
    );
    assert.equal(
      selectGrokAuthMethod([{ id: 'cached_token' }, { id: 'grok.com' }], {}),
      'cached_token',
    );
  });

  test('authenticate payload includes headless meta and prefers cached_token', () => {
    const profile = createGrokProfile({ binaryPath: '/bin/false', cwd: '/tmp', skipPreflight: true });
    const prev = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = 'sk-test';
    try {
      assert.deepEqual(
        profile.buildAuthenticate({ authMethods: [{ id: 'xai.api_key' }, { id: 'cached_token' }, { id: 'grok.com' }] }),
        { methodId: 'cached_token', _meta: { headless: true } },
      );
    } finally {
      if (prev === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prev;
    }
  });

  test('rejects community grok CLIs', () => {
    assert.equal(isOfficialGrokCli('xAI Grok CLI 1.2.0'), true);
    assert.equal(isOfficialGrokCli('grok agent stdio'), true);
    assert.equal(isOfficialGrokCli('Logstash grok pattern debugger'), false);
  });

  test('maps hyphenated Grok permission kinds the same way Cursor does', () => {
    const profile = createGrokProfile({ binaryPath: '/bin/false', cwd: '/tmp', skipPreflight: true });
    const mapped = profile.mapPermissionOptions([
      { optionId: 'allow-once', name: 'Allow once' },
      { optionId: 'reject-always', name: 'Reject always' },
    ]) as Array<{ optionId: string; kind: string }>;
    assert.deepEqual(mapped.map((o) => ({ optionId: o.optionId, kind: o.kind })), [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-always', kind: 'reject_always' },
    ]);
  });
});

describe('runtime factory registration', () => {
  async function loadFactories() {
    try {
      return await import('../src/agents/runtimeFactories');
    } catch (err) {
      if (String(err).includes('node:sqlite')) return null;
      throw err;
    }
  }

  test('RUNTIME_FACTORIES includes cursor and grok after existing ids', async () => {
    const mod = await loadFactories();
    if (!mod) {
      // Node 20 in this environment lacks node:sqlite; assert the source order instead.
      const fs = await import('node:fs');
      const src = fs.readFileSync(require('node:path').join(__dirname, '../src/agents/runtimeFactories.ts'), 'utf8');
      const ids = [...src.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(ids, ['kiro', 'pi', 'claude', 'codex', 'antigravity', 'cursor', 'grok']);
      return;
    }
    assert.deepEqual(
      mod.RUNTIME_FACTORIES.map((f) => f.id),
      ['kiro', 'pi', 'claude', 'codex', 'antigravity', 'cursor', 'grok'],
    );
  });

  test('getEnabledFactories() lists cursor and grok', async () => {
    const mod = await loadFactories();
    if (!mod) {
      const fs = await import('node:fs');
      const src = fs.readFileSync(require('node:path').join(__dirname, '../src/agents/runtimeFactories.ts'), 'utf8');
      assert.match(src, /id: "cursor"/);
      assert.match(src, /id: "grok"/);
      return;
    }
    const previous = process.env.MICHI_ENABLED_RUNTIMES;
    delete process.env.MICHI_ENABLED_RUNTIMES;
    try {
      const ids = mod.getEnabledFactories().map((f) => f.id);
      assert.ok(ids.includes('cursor'));
      assert.ok(ids.includes('grok'));
    } finally {
      if (previous === undefined) delete process.env.MICHI_ENABLED_RUNTIMES;
      else process.env.MICHI_ENABLED_RUNTIMES = previous;
    }
  });

  test('Grok factory does not register XAI_API_KEY envBindings', async () => {
    const mod = await loadFactories();
    if (!mod) {
      const fs = await import('node:fs');
      const src = fs.readFileSync(require('node:path').join(__dirname, '../src/agents/runtimeFactories.ts'), 'utf8');
      const grokBlock = src.slice(src.indexOf('id: "grok"'));
      assert.doesNotMatch(grokBlock.slice(0, 400), /envBindings/);
      return;
    }
    const grok = mod.RUNTIME_FACTORIES.find((f) => f.id === 'grok');
    assert.ok(grok);
    assert.equal(grok!.envBindings, undefined);
  });
});

describe('ACP initialize-result gating helpers', () => {
  const advertised = {
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { http: true },
      promptCapabilities: { image: true },
    },
  };
  const silent = { agentCapabilities: {} };

  test('probes loadSession / http MCP / image from initialize result', () => {
    assert.equal(acpSupportsLoadSession(advertised), true);
    assert.equal(acpSupportsHttpMcp(advertised), true);
    assert.equal(acpSupportsImagePrompt(advertised), true);
    assert.equal(acpSupportsLoadSession(silent), false);
    assert.equal(acpSupportsHttpMcp(silent), false);
    assert.equal(acpSupportsImagePrompt(silent), false);
    assert.equal(acpSupportsLoadSession(null), false);
  });

  test('MCP attach is always-on for Kiro/Cursor/Grok; ifAdvertised still gates when asked', () => {
    assert.equal(acpShouldAttachMcp('always', silent, 'kiro'), true);
    assert.equal(acpShouldAttachMcp('always', silent, 'cursor'), true);
    assert.equal(acpShouldAttachMcp('always', silent, 'grok'), true);
    assert.equal(acpShouldAttachMcp('ifAdvertised', silent, 'cursor'), false);
    assert.equal(acpShouldAttachMcp('ifAdvertised', advertised, 'cursor'), true);
    assert.equal(acpShouldAttachMcp('ifAdvertised', silent, 'grok'), false);
    assert.equal(acpShouldAttachMcp('ifAdvertised', advertised, 'grok'), true);
    assert.equal(acpShouldAttachMcp(undefined, silent, 'kiro'), true);
    assert.equal(acpShouldAttachMcp(undefined, silent, 'cursor'), false);
  });
});

describe('Cursor/Grok do not inherit the Kiro set_branch_overview reminder', () => {
  async function promptText(runtimeId: string): Promise<string> {
    const prompts: string[] = [];
    const fakeRuntime = {
      id: runtimeId,
      shouldSendBranchOverviewReminder: () => runtimeId === 'kiro',
      ensureClient: async () => ({
        prompt: async function* (_sid: string, text: string) {
          prompts.push(text);
          yield { sessionUpdate: 'turn_end', stopReason: 'end_turn' };
        },
      }),
      getCurrentMode: () => undefined,
      getCurrentModel: () => undefined,
    };
    const session = new KiroSession('n', 's', fakeRuntime as any, '/tmp');
    for await (const _ of session.send('hello')) { /* drain */ }
    return prompts[0];
  }

  test('Kiro still receives the reminder', async () => {
    assert.match(await promptText('kiro'), /set_branch_overview/);
  });

  test('Cursor turns do not include the Kiro reminder', async () => {
    assert.doesNotMatch(await promptText('cursor'), /set_branch_overview/);
  });

  test('Grok turns do not include the Kiro reminder', async () => {
    assert.doesNotMatch(await promptText('grok'), /set_branch_overview/);
  });
});

describe('Cursor/Grok runtime capability overrides', () => {
  test('runtime sources override Kiro MCP defaults and gate MCP attach', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const acp = fs.readFileSync(path.join(__dirname, '../src/agents/acp/AcpRuntime.ts'), 'utf8');
    const cursor = fs.readFileSync(path.join(__dirname, '../src/agents/cursor/CursorRuntime.ts'), 'utf8');
    const grok = fs.readFileSync(path.join(__dirname, '../src/agents/grok/GrokRuntime.ts'), 'utf8');
    const kiro = fs.readFileSync(path.join(__dirname, '../src/agents/kiro/KiroRuntime.ts'), 'utf8');
    assert.match(acp, /CURSOR_GROK_ACP_CAPABILITIES/);
    assert.match(acp, /saveContext:\s*true/);
    assert.match(acp, /spawnBranches:\s*true/);
    assert.match(acp, /nativeResume:\s*true/);
    assert.match(acp, /modes:\s*false/);
    assert.match(acp, /shouldAttachMcp/);
    assert.match(acp, /applyInitializeResult/);
    assert.match(cursor, /CURSOR_GROK_ACP_CAPABILITIES/);
    assert.match(cursor, /modes:\s*true/);
    assert.match(cursor, /mcpAttach:\s*"always"/);
    assert.match(cursor, /branchOverviewReminder:\s*false/);
    assert.match(grok, /CURSOR_GROK_ACP_CAPABILITIES/);
    assert.match(grok, /mcpAttach:\s*"always"/);
    assert.match(grok, /branchOverviewReminder:\s*false/);
    assert.doesNotMatch(kiro, /mcpAttach:\s*"ifAdvertised"/);
    assert.doesNotMatch(kiro, /CURSOR_GROK_ACP_CAPABILITIES/);
  });
});
