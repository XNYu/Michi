import { beforeEach, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetHostEventWarnings,
  decodeMichiHostEvent,
  encodeMichiHostEvent,
  type HostEvent,
  type MichiHostEvent,
} from '../src/agents/hostEvents';
import { log } from '../src/services/logger';

const EVENTS: MichiHostEvent[] = [
  { type: 'spawn_branches', payload: { topics: [{ title: 'Alpha', prompt: 'Explore alpha', chatId: 'chat-a', nodeId: 'node-a' }] } },
  { type: 'spawn_branches', payload: { topics: [] } },
  { type: 'branch_overview', payload: { overview: 'Explored alpha.' } },
  { type: 'follow_ups', payload: { followUps: ['First?', 'Second?', 'Third?'] } },
  { type: 'follow_ups_status', payload: { status: 'in_progress' } },
  { type: 'follow_ups_status', payload: { status: 'completed' } },
  { type: 'follow_ups_status', payload: { status: 'failed' } },
  { type: 'artifact_saved', payload: { contextId: 'ctx-1', name: 'notes', filePath: '.contexts/notes.md', size: 10 } },
  { type: 'artifact_updated', payload: { contextId: undefined, name: 'notes', filePath: '.contexts/notes.md', size: undefined } },
  { type: 'image', payload: { path: 'chart.png', caption: 'Chart', mimeType: 'image/png', size: 16 } },
  { type: 'image', payload: { path: 'chart.png', caption: undefined, mimeType: 'image/png', size: 16 } },
];

function hostEvent(type: string, payload: unknown): HostEvent {
  return { kind: 'host_event', type, payload };
}

function warnings(t: TestContext) {
  return t.mock.method(log, 'warn', () => {});
}

describe('Michi host events', () => {
  beforeEach(() => __resetHostEventWarnings());

  test('encode carries the type and payload as a host event, and decode returns them', () => {
    for (const event of EVENTS) {
      const encoded = encodeMichiHostEvent(event);
      assert.deepEqual(encoded, { kind: 'host_event', type: event.type, payload: event.payload });
      assert.deepEqual(decodeMichiHostEvent(encoded), event);
    }
  });

  test('decode rebuilds artifact and image payloads with the wire fields in wire order', () => {
    const artifact = decodeMichiHostEvent(hostEvent('artifact_saved', { size: 3, filePath: 'f.md', name: 'f', extra: true }));
    assert.equal(JSON.stringify(artifact?.payload), '{"name":"f","filePath":"f.md","size":3}');
    assert.deepEqual(Object.keys(artifact?.payload ?? {}), ['contextId', 'name', 'filePath', 'size']);
    const image = decodeMichiHostEvent(hostEvent('image', { size: 4, mimeType: 'image/png', path: 'a.png', extra: true }));
    assert.deepEqual(Object.keys(image?.payload ?? {}), ['path', 'caption', 'mimeType', 'size']);
  });

  test('decode passes reported arrays through unchanged', () => {
    const topics = [{ title: 'Alpha', prompt: 'Explore alpha', chatId: 'chat-a', nodeId: 'node-a' }];
    const followUps = ['First?'];
    const spawn = decodeMichiHostEvent(hostEvent('spawn_branches', { topics }));
    const follow = decodeMichiHostEvent(hostEvent('follow_ups', { followUps }));
    assert.equal(spawn?.type === 'spawn_branches' && spawn.payload.topics, topics);
    assert.equal(follow?.type === 'follow_ups' && follow.payload.followUps, followUps);
  });

  test('a spawn_branches event keeps its well-formed topics and drops only the malformed ones', (t) => {
    const warn = warnings(t);
    const alpha = { title: 'Alpha', prompt: 'Explore alpha', chatId: 'chat-a', nodeId: 'node-a' };
    const beta = { title: 'Beta', prompt: 'Explore beta', chatId: 'chat-b' };
    for (let i = 0; i < 2; i++) {
      const spawn = decodeMichiHostEvent(hostEvent('spawn_branches', {
        topics: [alpha, { title: 'No chat', prompt: 'Lost' }, null, beta, { ...beta, nodeId: 7 }],
      }));
      assert.deepEqual(spawn, { type: 'spawn_branches', payload: { topics: [alpha, beta] } });
    }
    assert.deepEqual(warn.mock.calls.map((call) => [call.arguments[1], call.arguments[2]]), [
      ['host event kept without its malformed topics', { type: 'spawn_branches' }],
    ]);
  });

  test('a malformed payload is dropped and logged once per type', (t) => {
    const warn = warnings(t);
    const malformed: Array<[string, unknown]> = [
      ['spawn_branches', { topics: [{ title: 'Alpha', prompt: 'Explore alpha' }] }],
      ['spawn_branches', { topics: 'Alpha' }],
      ['branch_overview', { overview: 42 }],
      ['follow_ups', { followUps: ['First?', 2] }],
      ['follow_ups_status', { status: 'done' }],
      ['artifact_saved', { name: 'notes' }],
      ['artifact_updated', { name: 'notes', filePath: 'n.md', size: '10' }],
      ['image', { path: 'chart.png', mimeType: 'image/png' }],
      ['image', null],
      ['image', ['chart.png']],
    ];
    for (const [type, payload] of malformed) {
      assert.equal(decodeMichiHostEvent(hostEvent(type, payload)), null, `${type} ${JSON.stringify(payload)}`);
    }
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments[2]), [
      { type: 'spawn_branches' }, { type: 'branch_overview' }, { type: 'follow_ups' }, { type: 'follow_ups_status' },
      { type: 'artifact_saved' }, { type: 'artifact_updated' }, { type: 'image' },
    ]);
    assert.ok(warn.mock.calls.every((call) => call.arguments[0] === 'chat' && call.arguments[1] === 'host event dropped: malformed payload'));
  });

  test('a host event of another type is dropped and logged once per type', (t) => {
    const warn = warnings(t);
    assert.equal(decodeMichiHostEvent(hostEvent('title', { title: 'Not a product event' })), null);
    assert.equal(decodeMichiHostEvent(hostEvent('title', { title: 'Again' })), null);
    assert.equal(decodeMichiHostEvent(hostEvent('x'.repeat(200), {})), null);
    // Logged by its first 64 characters, so it is one problem, logged once.
    assert.equal(decodeMichiHostEvent(hostEvent(`${'x'.repeat(64)}y`, {})), null);
    assert.deepEqual(warn.mock.calls.map((call) => [call.arguments[1], call.arguments[2]]), [
      ['host event dropped: unknown type', { type: 'title' }],
      ['host event dropped: unknown type', { type: 'x'.repeat(64) }],
    ]);
  });

  test('tests can forget which problems were logged', (t) => {
    const warn = warnings(t);
    decodeMichiHostEvent(hostEvent('title', {}));
    decodeMichiHostEvent(hostEvent('title', {}));
    __resetHostEventWarnings();
    decodeMichiHostEvent(hostEvent('title', {}));
    assert.equal(warn.mock.callCount(), 2);
  });
});
