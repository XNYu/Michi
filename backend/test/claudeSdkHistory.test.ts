import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { forkClaudeHistory } from 'michi-runtime/internal/adapters/claude/claudeSdkHistory';
import { getClaudeJsonlPath, getClaudeProjectsDir } from 'michi-runtime/internal/adapters/claude/claudeProjectsPath';
import { NativeResumeUnavailableError } from '../src/services/nativeResume';
import { claudeTestOptions } from './helpers/claudeTestOptions';

/** The adapter options the paths depend on: Michi's, over a test host. */
const claude = claudeTestOptions();

let directory: string;
let cwd: string;
let sourceId: string;
let source: Record<string, unknown>[];
const originalEnv = { ...process.env };

beforeEach((t) => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-claude-history-'));
  cwd = path.join(directory, 'project');
  fs.mkdirSync(cwd);
  (t as TestContext).mock.method(require('../src/services/agentConfig'), 'resolveClaudeConfigDir', () => path.join(directory, 'claude-profile'));
  delete process.env.MICHI_CLOUD;
  sourceId = randomUUID();
  let parent: string | null = null;
  source = [];
  for (const [role, content] of [
    ['user', 'Remember 6241'],
    ['assistant', [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/reference' } }]],
    ['user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'reference' }]],
    ['assistant', [{ type: 'text', text: 'Remembered 6241' }]],
    ['user', 'Replace it with 7352'],
    ['assistant', [{ type: 'text', text: 'Remembered 7352' }]],
  ]) {
    const uuid = randomUUID();
    source.push({ type: role, uuid, parentUuid: parent, sessionId: sourceId, cwd,
      isSidechain: false, userType: 'external', timestamp: '2026-10-22T00:00:00.000Z',
      version: '2.1.305', message: { role, content } });
    parent = uuid;
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeSource(ownerUserId?: string): string {
  fs.mkdirSync(getClaudeProjectsDir(claude, cwd, ownerUserId), { recursive: true });
  const file = getClaudeJsonlPath(claude, cwd, sourceId, ownerUserId);
  fs.writeFileSync(file, source.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return file;
}

function readHistory(id: string, ownerUserId?: string): Record<string, any>[] {
  return fs.readFileSync(getClaudeJsonlPath(claude, cwd, id, ownerUserId), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('real SDK forks a complete tool cycle at the selected reply and remaps the native chain', async () => {
  const sourceFile = writeSource();
  const original = fs.readFileSync(sourceFile, 'utf8');
  const childId = await forkClaudeHistory(claude, { cwd, sourceNativeSessionId: sourceId, nativeMessageId: source[3].uuid as string });
  assert.notEqual(childId, sourceId);
  const child = readHistory(childId);
  const messages = child.filter((entry) => entry.type === 'user' || entry.type === 'assistant');
  assert.equal(messages.length, 4);
  assert.equal(JSON.stringify(child).includes('7352'), false, 'later history must not enter the child');
  assert.equal(messages[3].message.content[0].text, 'Remembered 6241');
  const oldIds = new Set(source.map((entry) => entry.uuid));
  for (let index = 0; index < messages.length; index++) {
    assert.equal(oldIds.has(messages[index].uuid), false);
    assert.equal(messages[index].sessionId, childId);
    assert.equal(messages[index].parentUuid, index === 0 ? null : messages[index - 1].uuid);
    assert.equal(messages[index].forkedFrom.sessionId, sourceId);
    assert.equal(messages[index].forkedFrom.messageUuid, source[index].uuid);
  }
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), original, 'forking must not rewrite the parent');
});

test('a user-message anchor stops before its assistant answer', async () => {
  writeSource();
  const childId = await forkClaudeHistory(claude, { cwd, sourceNativeSessionId: sourceId, nativeMessageId: source[0].uuid as string });
  const messages = readHistory(childId).filter((entry) => entry.type === 'user' || entry.type === 'assistant');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.content, 'Remember 6241');
});

test('native forks start without copied file undo snapshots', async () => {
  const anchor = source[3].uuid as string;
  source.splice(1, 0, { type: 'file-history-snapshot', messageId: source[0].uuid,
    snapshot: { messageId: source[0].uuid, trackedFileBackups: {}, timestamp: '2026-10-22T00:00:00.000Z' },
    isSnapshotUpdate: false });
  writeSource();
  const childId = await forkClaudeHistory(claude, { cwd, sourceNativeSessionId: sourceId, nativeMessageId: anchor });
  assert.equal(readHistory(childId).some((entry) => entry.type === 'file-history-snapshot'), false);
});

test('a selected inactive native branch is recovered without the newer sibling branch', async () => {
  const oldAnchor = source[5].uuid as string;
  const siblingUser = randomUUID();
  source.push({ ...source[4], uuid: siblingUser, parentUuid: source[3].uuid,
    message: { role: 'user', content: 'Sibling branch 9999' } });
  source.push({ ...source[5], uuid: randomUUID(), parentUuid: siblingUser,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Sibling answer 9999' }] } });
  writeSource();
  const childId = await forkClaudeHistory(claude, { cwd, sourceNativeSessionId: sourceId, nativeMessageId: oldAnchor });
  const child = readHistory(childId);
  assert.equal(JSON.stringify(child).includes('9999'), false);
  const messages = child.filter((entry) => entry.type === 'user' || entry.type === 'assistant');
  assert.equal(messages.length, 6);
  assert.equal(messages.at(-1)?.message.content[0].text, 'Remembered 7352');
});

test('future title, relocation, content replacements and latches cannot modify a historical child', async () => {
  const anchor = source[3].uuid as string;
  source.splice(0, 0, { type: 'custom-title', sessionId: sourceId, customTitle: 'Historical 6241' });
  source.push(
    { type: 'custom-title', sessionId: sourceId, customTitle: 'Future 7352' },
    { type: 'relocated', sessionId: sourceId, relocatedCwd: '/tmp/future-7352' },
    { type: 'content-replacement', sessionId: sourceId,
      replacements: [{ uuid: anchor, content: 'future-7352' }] },
    { type: 'atis-latch', sessionId: sourceId, atis: 'FUTURE7352' },
  );
  writeSource();
  const childId = await forkClaudeHistory(claude, { cwd, sourceNativeSessionId: sourceId, nativeMessageId: anchor });
  const child = readHistory(childId);
  assert.equal(JSON.stringify(child).toLowerCase().includes('7352'), false);
  assert.equal(child.find((entry) => entry.type === 'custom-title')?.customTitle, 'Historical 6241 (fork)');
  assert.equal(child.some((entry) => entry.type === 'relocated' || entry.type === 'content-replacement' || entry.type === 'atis-latch'), false);
  assert.equal(child.filter((entry) => entry.type === 'assistant').at(-1)?.message.content[0].text, 'Remembered 6241');
});

test('forking before and after compaction preserves the selected native chain', async () => {
  const beforeCompaction = source[3].uuid as string;
  const boundary = randomUUID();
  const summary = randomUUID();
  const afterCompaction = randomUUID();
  source.push(
    { type: 'system', subtype: 'compact_boundary', uuid: boundary, parentUuid: null,
      sessionId: sourceId, timestamp: '2026-10-22T00:01:00.000Z', content: 'Conversation compacted',
      compactMetadata: { trigger: 'manual', preTokens: 120000 } },
    { type: 'user', uuid: summary, parentUuid: boundary, sessionId: sourceId,
      timestamp: '2026-10-22T00:01:01.000Z', isCompactSummary: true,
      message: { role: 'user', content: 'Compacted summary remembers 7352' } },
    { type: 'assistant', uuid: afterCompaction, parentUuid: summary, sessionId: sourceId,
      timestamp: '2026-10-22T00:01:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'After compaction 7352' }] } },
  );
  writeSource();
  const oldChild = await forkClaudeHistory(claude, { cwd, sourceNativeSessionId: sourceId, nativeMessageId: beforeCompaction });
  assert.equal(JSON.stringify(readHistory(oldChild)).includes('7352'), false);
  assert.equal(readHistory(oldChild).some((entry) => entry.subtype === 'compact_boundary'), false);

  const compactChild = await forkClaudeHistory(claude, { cwd, sourceNativeSessionId: sourceId, nativeMessageId: afterCompaction });
  const child = readHistory(compactChild);
  const compact = child.find((entry) => entry.subtype === 'compact_boundary');
  const compactSummary = child.find((entry) => entry.isCompactSummary);
  const finalAnswer = child.filter((entry) => entry.type === 'assistant').at(-1);
  assert.ok(compact);
  assert.ok(compactSummary);
  assert.equal(compact.parentUuid, null);
  assert.equal(compactSummary.parentUuid, compact.uuid);
  assert.equal(finalAnswer?.parentUuid, compactSummary.uuid);
  assert.equal(finalAnswer?.message.content[0].text, 'After compaction 7352');
});

test('a configuration change during SDK loading cannot redirect the child to another profile', async (t) => {
  const sourceFile = writeSource();
  const transport = require('michi-runtime/internal/adapters/claude/claudeSdkTransport');
  const load = transport.loadClaudeSdk;
  t.mock.method(transport, 'loadClaudeSdk', async () => {
    const sdk = await load();
    t.mock.method(require('../src/services/agentConfig'), 'resolveClaudeConfigDir', () => path.join(directory, 'other-profile'));
    return sdk;
  });
  const childId = await forkClaudeHistory(claude, { cwd, sourceNativeSessionId: sourceId, nativeMessageId: source[3].uuid as string });
  assert.equal(fs.existsSync(path.join(path.dirname(sourceFile), `${childId}.jsonl`)), true);
  assert.equal(fs.existsSync(getClaudeJsonlPath(claude, cwd, childId)), false);
});

test('missing and subagent anchors never create a latest-state child file', async () => {
  const sidechainId = randomUUID();
  source.push({ type: 'assistant', uuid: sidechainId, isSidechain: true, sessionId: sourceId,
    message: { role: 'assistant', content: [{ type: 'text', text: 'nested response' }] } });
  writeSource();
  for (const nativeMessageId of [randomUUID(), sidechainId]) {
    await assert.rejects(forkClaudeHistory(claude, { cwd, sourceNativeSessionId: sourceId, nativeMessageId }), NativeResumeUnavailableError);
  }
  assert.deepEqual(fs.readdirSync(getClaudeProjectsDir(claude, cwd)), [`${sourceId}.jsonl`]);
});

// This tests the store's path isolation only. Runtime cloud fork deliberately
// falls back to text until the CLI and helper history layouts are aligned.
test('the scoped history store keeps cloud owner paths isolated', async () => {
  process.env.MICHI_CLOUD = '1';
  writeSource('alice');
  await assert.rejects(forkClaudeHistory(claude, { cwd, sourceNativeSessionId: sourceId,
    nativeMessageId: source[3].uuid as string, ownerUserId: 'bob' }), NativeResumeUnavailableError);
  const childId = await forkClaudeHistory(claude, { cwd, sourceNativeSessionId: sourceId,
    nativeMessageId: source[3].uuid as string, ownerUserId: 'alice' });
  assert.equal(fs.existsSync(getClaudeJsonlPath(claude, cwd, childId, 'alice')), true);
  assert.equal(fs.existsSync(getClaudeJsonlPath(claude, cwd, childId, 'bob')), false);
  assert.equal(fs.existsSync(getClaudeJsonlPath(claude, cwd, childId)), false);
});

test('invalid native IDs are rejected before resolving a file path', async () => {
  await assert.rejects(forkClaudeHistory(claude, { cwd, sourceNativeSessionId: '../../other-owner',
    nativeMessageId: source[3].uuid as string }), NativeResumeUnavailableError);
});
