import { editHomeCustomization, readHomeCustomization } from '../src/services/homeCards/repository';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { HomeCard, HomeCardsDto } from 'michi-shared';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, initDb } from '../src/services/db';
import { setupHomeCardsRoutes } from '../src/routes/homeCards';

let dataDir: string;
let server: Server | undefined;
let previousDataDir: string | undefined;
let baseUrl = '';
let clock = 1_000;

beforeEach(async () => {
  previousDataDir = process.env.MICHI_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-home-cards-'));
  process.env.MICHI_DATA_DIR = dataDir;
  closeDb();
  initDb();
  clock = 1_000;
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => {
    (req as any).user = { id: req.header('x-user-id') ?? LOCAL_AGENT_OWNER_ID, email: 'test@example.test' };
    next();
  });
  app.use('/api', setupHomeCardsRoutes({ clock: () => clock }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  closeDb();
  if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(pathname: string, init: RequestInit & { user?: string } = {}): Promise<Response> {
  const { user, ...rest } = init;
  return fetch(`${baseUrl}${pathname}`, {
    ...rest,
    headers: { ...(rest.body ? { 'content-type': 'application/json' } : {}), ...(user ? { 'x-user-id': user } : {}), ...rest.headers },
  });
}
const put = (body: unknown, init: RequestInit & { user?: string } = {}) => request('/home/cards', { method: 'PUT', body: JSON.stringify(body), ...init });
const read = async (user?: string) => (await (await request('/home/cards', { user })).json()) as HomeCardsDto;

function card(id: string, extra: Partial<HomeCard> = {}): HomeCard {
  return {
    id, kind: 'continue', label: 'rabbitholes', source: { workspaceId: 'ws-a', threadNodeId: `n-${id}` },
    title: `Title ${id}`, reason: 'Two cases left.', buttonText: '接着做', prompt: `Prompt ${id}`, workspaceId: 'ws-a', ...extra,
  };
}
const write = (sets: HomeCard[][], extra: Record<string, unknown> = {}) => ({
  greeting: { text: '早上好。', detail: 'Michi 0.9 还有 5 天发布。' }, sets: sets.map((cards) => ({ cards })), inputFingerprint: 'fp-1', ...extra,
});

test('an owner with no cards gets an empty answer', async () => {
  const response = await request('/home/cards');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { greeting: null, sets: [], generatedAt: null, inputFingerprint: null });
  assert.equal((await request('/home/cards?x=1')).status, 400);
});

test('a write replaces the greeting and sets, stamped with the server clock', async () => {
  clock = 5_000;
  const first = await put(write([[card('a'), card('b', { kind: 'tip', workspaceId: null, source: {}, prompt: '' })], [card('c')]]));
  assert.equal(first.status, 200);
  const body = await first.json() as HomeCardsDto;
  assert.deepEqual(body.greeting, { text: '早上好。', detail: 'Michi 0.9 还有 5 天发布。' });
  assert.deepEqual(body.sets.map((set) => set.cards.map((entry) => entry.id)), [['a', 'b'], ['c']]);
  assert.deepEqual(body.sets[0]!.cards[1], card('b', { kind: 'tip', workspaceId: null, source: {}, prompt: '' }));
  assert.deepEqual([body.generatedAt, body.inputFingerprint], [5_000, 'fp-1']);
  assert.deepEqual(await read(), body);

  clock = 6_000;
  await put(write([[card('d')]], { greeting: null, inputFingerprint: null }));
  const second = await read();
  assert.deepEqual([second.greeting, second.generatedAt, second.inputFingerprint], [null, 6_000, null]);
  assert.deepEqual(second.sets.map((set) => set.cards.map((entry) => entry.id)), [['d']]);
});

test('a set holds at most one tip card', async () => {
  const response = await put(write([[card('a', { kind: 'tip' }), card('b', { kind: 'tip' })]]));
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'too_many_tips');
  assert.deepEqual((await read()).sets, []);
  // One tip in each of two sets is fine.
  assert.equal((await put(write([[card('a', { kind: 'tip' })], [card('b', { kind: 'tip' })]]))).status, 200);
});

test('a write is refused unless every card is well formed', async () => {
  const bad: Array<[string, unknown]> = [
    ['unknown body field', { ...write([[card('a')]]), extra: 1 }],
    ['sets missing', { greeting: null }],
    ['empty set', write([[]])],
    ['seven cards', write([Array.from({ length: 7 }, (_, i) => card(`c${i}`))])],
    ['nine sets', write(Array.from({ length: 9 }, (_, i) => [card(`s${i}`)]))],
    ['unknown kind', write([[card('a', { kind: 'news' as never })]])],
    ['empty title', write([[card('a', { title: ' ' })]])],
    ['unknown card field', write([[{ ...card('a'), color: 'red' } as HomeCard]])],
    ['unknown source field', write([[card('a', { source: { url: 'x' } as never })]])],
    ['workspaceId missing', write([[(({ workspaceId: _omit, ...rest }) => rest)(card('a')) as HomeCard]])],
    ['greeting without text', write([[card('a')]], { greeting: { detail: 'x' } })],
  ];
  for (const [name, body] of bad) {
    const response = await put(body);
    assert.equal(response.status, 400, name);
  }
  const duplicate = await put(write([[card('a')], [card('a')]]));
  assert.equal(((await duplicate.json()) as { error: { code: string } }).error.code, 'duplicate_card');
  assert.deepEqual((await read()).sets, []);
});

test('a used card is left out from then on, also after a rewrite that keeps its id', async () => {
  await put(write([[card('a'), card('b')], [card('c')]]));
  clock = 7_000;
  const used = await request('/home/cards/a/used', { method: 'POST' });
  assert.equal(used.status, 200);
  assert.deepEqual(await used.json(), { cardId: 'a', usedAt: 7_000 });
  clock = 8_000;
  assert.deepEqual(await (await request('/home/cards/a/used', { method: 'POST' })).json(), { cardId: 'a', usedAt: 7_000 });
  assert.deepEqual((await read()).sets.map((set) => set.cards.map((entry) => entry.id)), [['b'], ['c']]);

  // A set left with no cards is dropped.
  await request('/home/cards/c/used', { method: 'POST' });
  assert.deepEqual((await read()).sets.map((set) => set.cards.map((entry) => entry.id)), [['b']]);

  await put(write([[card('a'), card('e')]]));
  assert.deepEqual((await read()).sets.map((set) => set.cards.map((entry) => entry.id)), [['e']]);
  assert.equal((await request('/home/cards/zzz/used', { method: 'POST' })).status, 404);
});

test('each owner sees and marks only their own cards', async () => {
  await put(write([[card('a')]]));
  await put(write([[card('b')]], { greeting: { text: 'Hi Bob', detail: null } }), { user: 'bob' });
  assert.deepEqual((await read()).sets[0]!.cards.map((entry) => entry.id), ['a']);
  const bob = await read('bob');
  assert.deepEqual([bob.greeting, bob.sets[0]!.cards.map((entry) => entry.id)], [{ text: 'Hi Bob', detail: null }, ['b']]);
  assert.deepEqual(await read('carol'), { greeting: null, sets: [], generatedAt: null, inputFingerprint: null });

  assert.equal((await request('/home/cards/a/used', { method: 'POST', user: 'bob' })).status, 404);
  assert.equal((await request('/home/cards/a/used', { method: 'POST', user: 'carol' })).status, 404);
  assert.equal((await read()).sets[0]!.cards.length, 1);
  assert.equal((await request('/home/cards/b/used', { method: 'POST', user: 'bob' })).status, 200);
  assert.deepEqual((await read('bob')).sets, []);
  assert.equal((await read()).sets[0]!.cards.length, 1);
});

test('only this machine\'s own app may write the cards', async () => {
  const foreignOrigin = await put(write([[card('a')]]), { headers: { origin: 'https://example.com' } });
  assert.equal(foreignOrigin.status, 403);
  // fetch cannot set Host, so a DNS-rebinding request goes through node:http.
  const foreignHost = await new Promise<number>((resolve, reject) => {
    const body = JSON.stringify(write([[card('a')]]));
    const req = http.request(`${baseUrl}/home/cards`, { method: 'PUT', headers: { host: 'michi.example.com', 'content-type': 'application/json' } },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(foreignHost, 403);
  assert.deepEqual((await read()).sets, []);
  // Reading and marking are ordinary owner requests.
  assert.equal((await request('/home/cards', { headers: { origin: 'https://example.com' } })).status, 200);
});


test('custom Home survives generation, isolates owners, validates atomically and restores automatic content', async () => {
  await put(write([[card('a')]]));
  editHomeCustomization(LOCAL_AGENT_OWNER_ID, { expectedRevision: 0, greetingMode: 'custom', greetingText: 'My summary', cardsMode: 'custom', setsJson: JSON.stringify([{ cards: [card('custom')] }]) });
  await put(write([[card('new')]], { greeting: { text: 'New generated summary' } }));
  assert.equal((await read()).greeting?.text, 'My summary');
  assert.equal((await read()).sets[0].cards[0].id, 'custom');
  assert.equal((await read('someone-else')).greeting, null);
  assert.equal((await request('/home/cards/custom/used', { method: 'POST' })).status, 200);
  assert.deepEqual((await read()).sets, []);
  assert.throws(() => editHomeCustomization(LOCAL_AGENT_OWNER_ID, { expectedRevision: 1, greetingMode: 'hidden', cardsMode: 'custom', setsJson: '[{}]' }));
  assert.equal(readHomeCustomization(LOCAL_AGENT_OWNER_ID).revision, 1);
  assert.equal((await read()).greeting?.text, 'My summary');
  editHomeCustomization(LOCAL_AGENT_OWNER_ID, { expectedRevision: 1, greetingMode: 'hidden', cardsMode: 'hidden' });
  await put(write([[card('later')]]));
  assert.equal((await read()).greeting, null);
  assert.deepEqual((await read()).sets, []);
  closeDb(); initDb();
  assert.equal((await read()).cardsCustomized, true);
  editHomeCustomization(LOCAL_AGENT_OWNER_ID, { expectedRevision: 2, greetingMode: 'auto', cardsMode: 'auto' });
  assert.equal((await read()).greeting?.text, '早上好。');
  assert.equal((await read()).sets[0].cards[0].id, 'later');
});
