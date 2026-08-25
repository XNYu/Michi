import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryHarnessJournal } from '../src/services/harnessJournal';

describe('harnessJournal', () => {
  test('memory journal is append-only and keyed by node/turn/seq', () => {
    const journal = new MemoryHarnessJournal();
    journal.append({
      nodeId: 'n1',
      turnId: 't1',
      seq: 0,
      event: 'chunk',
      source: 'native',
      confidence: 'native',
      payload: '{"text":"hi"}',
      createdAt: 1,
    });
    journal.append({
      nodeId: 'n1',
      turnId: 't1',
      seq: 1,
      event: 'done',
      source: 'michi_simulated',
      confidence: 'projected',
      payload: '{}',
      createdAt: 2,
    });
    assert.equal(journal.entries.length, 2);
    assert.deepEqual(journal.entries.map((e) => e.seq), [0, 1]);
    assert.equal(journal.entries[0].event, 'chunk');
  });
});
