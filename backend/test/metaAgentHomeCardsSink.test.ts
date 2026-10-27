import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, initDb } from '../src/services/db';
import { readHomeCards } from '../src/services/homeCards/repository';
import { repositoryHomeCardsSink } from '../src/services/metaAgent/homeCardsSink';
import type { HomeCard, HomeCardsWrite } from '../src/services/metaAgent/homeCardsGenerator';

let dir: string;
let prior: string | undefined;

beforeEach(() => {
  prior = process.env.MICHI_DATA_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-home-cards-sink-'));
  process.env.MICHI_DATA_DIR = dir;
  closeDb(); initDb();
});

afterEach(() => {
  closeDb();
  if (prior === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = prior;
  fs.rmSync(dir, { recursive: true, force: true });
});

const card = (id: string, kind: HomeCard['kind'] = 'continue'): HomeCard => ({
  id, kind, label: 'Continue · ws', source: {}, title: `Card ${id}`, reason: 'A reason', buttonText: 'Go', prompt: 'Do it', workspaceId: null,
});

test('generated cards land in the Home cards storage', () => {
  const cards: HomeCardsWrite = { greeting: { text: 'Morning.', detail: null }, sets: [{ cards: [card('a'), card('b')] }], inputFingerprint: 'fp-1' };
  repositoryHomeCardsSink.write(LOCAL_AGENT_OWNER_ID, cards, 1_000);
  const stored = readHomeCards(LOCAL_AGENT_OWNER_ID);
  assert.equal(stored.greeting?.text, 'Morning.');
  assert.deepEqual(stored.sets.map((set) => set.cards.map((entry) => entry.id)), [['a', 'b']]);
  assert.equal(stored.inputFingerprint, 'fp-1');
});

test('a set that fails validation is not stored and the previous cards stay', () => {
  repositoryHomeCardsSink.write(LOCAL_AGENT_OWNER_ID, { greeting: null, sets: [{ cards: [card('a')] }], inputFingerprint: 'fp-1' }, 1_000);
  assert.doesNotThrow(() => repositoryHomeCardsSink.write(LOCAL_AGENT_OWNER_ID,
    { greeting: null, sets: [{ cards: [card('t1', 'tip'), card('t2', 'tip')] }], inputFingerprint: 'fp-2' }, 2_000));
  assert.equal(readHomeCards(LOCAL_AGENT_OWNER_ID).inputFingerprint, 'fp-1');
});
